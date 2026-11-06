import { AuthApiClient } from '../api/auth';
import { HttpClientError } from '../api/http-client';
import { AppError, ErrorCode } from '../errors/types';
import { AuthService } from './index';
import { SessionManager } from './session';

jest.mock('../api/auth', () => ({
  AuthApiClient: jest.fn(),
}));

jest.mock('./session', () => ({
  SessionManager: {
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    clearInvalidSession: jest.fn(),
    hasValidSession: jest.fn(),
    refreshSession: jest.fn(),
    removeKeyPassword: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));

const MockedAuthApiClient = AuthApiClient as jest.MockedClass<typeof AuthApiClient>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;

describe('AuthService', () => {
  const logout = jest.fn();
  const calls: string[] = [];
  const session = {
    uid: 'uid-123',
    accessToken: 'opaque-access-token',
    refreshToken: 'refresh-token',
    scopes: ['full'],
    tokenExpiresAt: Date.now() + 3_600_000,
    keyPasswordProvider: 'git-credential' as const,
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    logout.mockImplementation(async () => { calls.push('logout'); });
    mockedSessionManager.removeKeyPassword.mockImplementation(async () => { calls.push('remove-key-password'); });
    mockedSessionManager.clearSession.mockImplementation(async () => { calls.push('clear-session'); return true; });
    mockedSessionManager.clearInvalidSession.mockImplementation(async () => { calls.push('clear-invalid-session'); return true; });
    MockedAuthApiClient.mockImplementation(() => ({ logout } as unknown as AuthApiClient));
  });

  it('returns the saved browser-fork session without refreshing it, even near expiry', async () => {
    const expiring = { ...session, tokenExpiresAt: Date.now() + 30_000 };
    mockedSessionManager.loadSession.mockResolvedValue(expiring);

    await expect(new AuthService().getSession()).resolves.toEqual(expiring);

    expect(mockedSessionManager.refreshSession).not.toHaveBeenCalled();
  });

  it('fails closed when no session exists', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(null);

    await expect(new AuthService().getSession())
      .rejects.toThrow('No valid session found. Please login first using browser sign-in');
  });

  it('delegates auth status to the session manager', async () => {
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await expect(new AuthService().isAuthenticated()).resolves.toBe(true);
  });

  it('logs out: server revocation with the session UID, then key password, then the local state of that UID', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true });

    expect(logout).toHaveBeenCalledWith('uid-123', session.accessToken);
    expect(mockedSessionManager.removeKeyPassword).toHaveBeenCalledWith(session);
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
    expect(calls).toEqual(['logout', 'remove-key-password', 'clear-session']);
  });

  it('still removes the local session when the server revocation fails', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);
    logout.mockRejectedValue(new TypeError('fetch failed'));

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false });

    expect(mockedSessionManager.removeKeyPassword).toHaveBeenCalledWith(session);
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
  });

  it('treats a session already revoked elsewhere as ended without a second key-password removal', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);
    logout.mockRejectedValueOnce(new HttpClientError('Request failed with status 401', {
      response: { data: { Code: 401 }, status: 401, headers: {}, config: {} },
    }));
    mockedSessionManager.refreshSession.mockRejectedValue(
      new AppError('signed out', ErrorCode.SESSION_EXPIRED, { signedOut: true }, false),
    );

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true });

    expect(mockedSessionManager.removeKeyPassword).not.toHaveBeenCalled();
    expect(mockedSessionManager.clearSession).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token once to revoke the session', async () => {
    const expired = { ...session, tokenExpiresAt: Date.now() - 60_000 };
    mockedSessionManager.loadSession.mockResolvedValue(expired);
    mockedSessionManager.refreshSession.mockResolvedValue({ ...expired, accessToken: 'fresh-access-token' });
    logout
      .mockRejectedValueOnce(new HttpClientError('Request failed with status 401', {
        response: { data: { Code: 401 }, status: 401, headers: {}, config: {} },
      }))
      .mockResolvedValueOnce(undefined);

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(expired, undefined);
    expect(logout).toHaveBeenLastCalledWith('uid-123', 'fresh-access-token');
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
  });

  it('clears the local files of an invalid session without revoking anything', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(null);

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false });

    expect(logout).not.toHaveBeenCalled();
    expect(mockedSessionManager.removeKeyPassword).not.toHaveBeenCalled();
    expect(calls).toEqual(['clear-invalid-session']);
  });
});
