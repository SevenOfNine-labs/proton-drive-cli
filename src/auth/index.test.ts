import { AuthApiClient } from '../api/auth';
import { HttpClientError } from '../api/http-client';
import { AppError, ErrorCode } from '../errors/types';
import type { SessionCredentials, SessionRecord } from '../types/auth';
import { AuthService } from './index';
import { SessionManager } from './session';

jest.mock('../api/auth', () => ({
  AuthApiClient: jest.fn(),
}));

jest.mock('./session', () => ({
  SessionManager: {
    readStoredSession: jest.fn(),
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    clearInvalidSession: jest.fn(),
    hasValidSession: jest.fn(),
    refreshSession: jest.fn(),
    removeSecrets: jest.fn(),
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
  const record: SessionRecord = {
    uid: 'uid-123',
    scopes: ['full'],
    tokenExpiresAt: Date.now() + 3_600_000,
    credentialStore: 'git-credential',
    credentialHost: 'proton-drive-cli.invalid',
    revision: 'rev-1',
  };
  const session: SessionCredentials = {
    ...record,
    accessToken: 'opaque-access-token',
    refreshToken: 'refresh-token',
    keyPassword: 'key-password',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    logout.mockImplementation(async () => { calls.push('logout'); });
    mockedSessionManager.readStoredSession.mockResolvedValue({ kind: 'valid', record });
    mockedSessionManager.loadSession.mockResolvedValue(session);
    mockedSessionManager.removeSecrets.mockImplementation(async () => { calls.push('remove-secrets'); return true; });
    mockedSessionManager.clearSession.mockImplementation(async () => { calls.push('clear-session'); return true; });
    mockedSessionManager.clearInvalidSession.mockImplementation(async () => { calls.push('clear-invalid-session'); return true; });
    MockedAuthApiClient.mockImplementation(() => ({ logout } as unknown as AuthApiClient));
  });

  it('delegates auth status to the session manager', async () => {
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await expect(new AuthService().isAuthenticated()).resolves.toBe(true);
  });

  it('logs out: server revocation with the session UID, then the local state of that UID, then the credential-store entry', async () => {
    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

    expect(logout).toHaveBeenCalledWith('uid-123', session.accessToken);
    expect(mockedSessionManager.removeSecrets).toHaveBeenCalledWith(record);
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
    expect(calls).toEqual(['logout', 'clear-session', 'remove-secrets']);
  });

  it('reports an entry the credential store could not remove', async () => {
    mockedSessionManager.removeSecrets.mockImplementation(async () => { calls.push('remove-secrets'); return false; });

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: false });

    expect(calls).toEqual(['logout', 'clear-session', 'remove-secrets']);
  });

  it('still removes the local session when the server revocation fails', async () => {
    logout.mockRejectedValue(new TypeError('fetch failed'));

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false, credentialsRemoved: true });

    expect(mockedSessionManager.removeSecrets).toHaveBeenCalledWith(record);
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
  });

  it('removes the local session without a revocation when the credential store cannot return the entry', async () => {
    mockedSessionManager.loadSession.mockRejectedValue(
      new AppError('unreadable', ErrorCode.CREDENTIALS_UNAVAILABLE, { credentialStore: 'git-credential' }, true),
    );

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false, credentialsRemoved: true });

    expect(logout).not.toHaveBeenCalled();
    expect(calls).toEqual(['clear-session', 'remove-secrets']);
  });

  it('never revokes a session a login wrote between reading session.json and its entry', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({ ...session, uid: 'uid-next', revision: 'rev-next' });

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false, credentialsRemoved: true });

    expect(logout).not.toHaveBeenCalled();
    expect(mockedSessionManager.removeSecrets).toHaveBeenCalledWith(record);
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
  });

  it('treats a session already revoked elsewhere as ended without a second entry removal', async () => {
    logout.mockRejectedValueOnce(new HttpClientError('Request failed with status 401', {
      response: { data: { Code: 401 }, status: 401, headers: {}, config: {} },
    }));
    mockedSessionManager.refreshSession.mockRejectedValue(
      new AppError('signed out', ErrorCode.SESSION_EXPIRED, { signedOut: true }, false),
    );

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

    expect(mockedSessionManager.removeSecrets).not.toHaveBeenCalled();
    expect(mockedSessionManager.clearSession).not.toHaveBeenCalled();
  });

  it('reports the entry a sign-out during the revocation could not remove', async () => {
    logout.mockRejectedValueOnce(new HttpClientError('Request failed with status 401', {
      response: { data: { Code: 401 }, status: 401, headers: {}, config: {} },
    }));
    mockedSessionManager.refreshSession.mockRejectedValue(
      new AppError('signed out', ErrorCode.SESSION_EXPIRED, { signedOut: true, credentialsRemoved: false }, false),
    );

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: false });

    expect(mockedSessionManager.removeSecrets).not.toHaveBeenCalled();
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

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: true, credentialsRemoved: true });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(expired, undefined);
    expect(logout).toHaveBeenLastCalledWith('uid-123', 'fresh-access-token');
    expect(mockedSessionManager.clearSession).toHaveBeenCalledWith('uid-123');
  });

  it.each([
    ['an invalid session file', { kind: 'invalid' as const }],
    ['no session file', { kind: 'none' as const }],
  ])('clears the local files of %s without reading the store or revoking anything', async (_label, stored) => {
    mockedSessionManager.readStoredSession.mockResolvedValue(stored);

    await expect(new AuthService().logout()).resolves.toEqual({ revoked: false, credentialsRemoved: true });

    expect(mockedSessionManager.loadSession).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(mockedSessionManager.removeSecrets).not.toHaveBeenCalled();
    expect(calls).toEqual(['clear-invalid-session']);
  });
});
