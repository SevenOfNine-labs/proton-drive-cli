import { AuthApiClient } from '../api/auth';
import { AuthService } from './index';
import { SessionManager } from './session';
import { createKeyPasswordStore } from './key-password-store';

jest.mock('../api/auth', () => ({
  AuthApiClient: jest.fn(),
}));

jest.mock('./session', () => ({
  SessionManager: {
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    clearCryptoCache: jest.fn(),
    hasValidSession: jest.fn(),
    refreshSession: jest.fn(),
  },
}));

jest.mock('./key-password-store', () => ({
  createKeyPasswordStore: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn() },
}));

const MockedAuthApiClient = AuthApiClient as jest.MockedClass<typeof AuthApiClient>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const mockedCreateKeyPasswordStore = createKeyPasswordStore as jest.MockedFunction<typeof createKeyPasswordStore>;

describe('AuthService', () => {
  const logout = jest.fn();
  const removeKeyPassword = jest.fn();
  const calls: string[] = [];
  const session = {
    sessionId: 'uid-123',
    uid: 'uid-123',
    accessToken: 'opaque-access-token',
    refreshToken: 'refresh-token',
    scopes: ['full'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + 3_600_000,
    authMode: 'browser-fork' as const,
    keyPasswordPersisted: true,
    keyPasswordProvider: 'git-credential' as const,
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    logout.mockImplementation(async () => { calls.push('logout'); });
    removeKeyPassword.mockImplementation(async () => { calls.push('remove-key-password'); });
    mockedSessionManager.clearSession.mockImplementation(async () => { calls.push('clear-session'); });
    mockedSessionManager.clearCryptoCache.mockImplementation(async () => { calls.push('clear-crypto-cache'); });
    MockedAuthApiClient.mockImplementation(() => ({ logout } as unknown as AuthApiClient));
    mockedCreateKeyPasswordStore.mockReturnValue({
      provider: 'git-credential',
      host: 'proton-drive-key.proton-lfs-cli.local',
      store: jest.fn(),
      load: jest.fn(),
      remove: removeKeyPassword,
      verify: jest.fn(),
    });
  });

  it('returns the saved browser-fork session without refreshing when still valid', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);

    await expect(new AuthService().getSession()).resolves.toEqual(session);

    expect(mockedSessionManager.refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes a session whose tokenExpiresAt is within the threshold', async () => {
    const expiring = { ...session, tokenExpiresAt: Date.now() + 30_000 };
    const refreshed = { ...session, tokenExpiresAt: Date.now() + 3_600_000 };
    mockedSessionManager.loadSession.mockResolvedValue(expiring);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshed);

    await expect(new AuthService(undefined, 'external-drive-test@1.0.0').getSession())
      .resolves.toEqual(refreshed);

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(
      undefined,
      'external-drive-test@1.0.0',
    );
  });

  it('does not refresh a session without a known expiry (opaque token, no ExpiresIn)', async () => {
    const { tokenExpiresAt, ...opaque } = session;
    mockedSessionManager.loadSession.mockResolvedValue(opaque);

    await expect(new AuthService().getSession()).resolves.toEqual(opaque);

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

  it('logs out: key password first, then server revocation with the session UID, then local state', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);

    await new AuthService().logout();

    expect(removeKeyPassword).toHaveBeenCalledWith('uid-123');
    expect(logout).toHaveBeenCalledWith('uid-123', session.accessToken);
    expect(calls).toEqual(['remove-key-password', 'logout', 'clear-session', 'clear-crypto-cache']);
  });

  it('still removes the local session when the server revocation fails', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);
    logout.mockRejectedValue(new Error('Request failed with status 401'));

    await new AuthService().logout();

    expect(mockedSessionManager.clearSession).toHaveBeenCalled();
    expect(mockedSessionManager.clearCryptoCache).toHaveBeenCalled();
  });

  it('does not expose a direct account login method', () => {
    expect('login' in new AuthService()).toBe(false);
  });
});
