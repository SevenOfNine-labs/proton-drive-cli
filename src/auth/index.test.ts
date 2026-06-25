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

function jwtExpiringIn(seconds: number): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + seconds,
  })).toString('base64url');
  return `header.${payload}.signature`;
}

describe('AuthService', () => {
  const logout = jest.fn();
  const removeKeyPassword = jest.fn();
  const session = {
    sessionId: 'uid-123',
    uid: 'uid-123',
    accessToken: jwtExpiringIn(3600),
    refreshToken: 'refresh-token',
    scopes: ['full'],
    passwordMode: 1,
    authMode: 'browser-fork' as const,
    keyPasswordPersisted: true,
    keyPasswordProvider: 'git-credential' as const,
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('refreshes a locally expiring session', async () => {
    const expiring = { ...session, accessToken: jwtExpiringIn(30) };
    const refreshed = { ...session, accessToken: jwtExpiringIn(3600) };
    mockedSessionManager.loadSession.mockResolvedValue(expiring);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshed);

    await expect(new AuthService(undefined, 'external-drive-test@1.0.0').getSession())
      .resolves.toEqual(refreshed);

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(
      undefined,
      'external-drive-test@1.0.0',
    );
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

  it('logs out, clears browser-fork key password, and removes local session state', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(session);
    logout.mockResolvedValue(undefined);
    removeKeyPassword.mockResolvedValue(undefined);

    await new AuthService().logout();

    expect(logout).toHaveBeenCalledWith(session.accessToken);
    expect(removeKeyPassword).toHaveBeenCalledWith('uid-123');
    expect(mockedSessionManager.clearSession).toHaveBeenCalled();
    expect(mockedSessionManager.clearCryptoCache).toHaveBeenCalled();
  });

  it('does not expose a direct account login method', () => {
    expect('login' in new AuthService()).toBe(false);
  });
});
