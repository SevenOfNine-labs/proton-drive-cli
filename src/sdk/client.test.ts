const mockDriveCryptoInitialize = jest.fn();
const mockDriveCryptoInitializeWithUserKeyPassword = jest.fn();
const mockKeyPasswordLoad = jest.fn();

jest.mock('@protontech/drive-sdk', () => ({
  ProtonDriveClient: jest.fn().mockImplementation((args) => ({ args })),
  MemoryCache: jest.fn().mockImplementation(() => ({})),
  OpenPGPCryptoWithCryptoProxy: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./cryptoProxy', () => ({
  ProtonOpenPGPCryptoProxy: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./httpClientAdapter', () => ({
  HTTPClientAdapter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./accountAdapter', () => ({
  AccountAdapter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./srpAdapter', () => ({
  SRPModuleAdapter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('../crypto/drive-crypto', () => ({
  DriveCryptoService: jest.fn().mockImplementation(() => ({
    initialize: mockDriveCryptoInitialize,
    initializeWithUserKeyPassword: mockDriveCryptoInitializeWithUserKeyPassword,
  })),
}));

jest.mock('../auth/key-password-store', () => ({
  createKeyPasswordStore: jest.fn(() => ({
    provider: 'git-credential',
    host: 'proton-drive-key.proton-lfs-cli.local',
    load: mockKeyPasswordLoad,
  })),
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    loadSession: jest.fn(),
    hasValidSession: jest.fn(),
    refreshSession: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { ErrorCode } from '../errors/types';
import { SessionManager } from '../auth/session';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { HTTPClientAdapter } from './httpClientAdapter';
import { createSDKClient } from './client';

const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const MockedDriveCryptoService = DriveCryptoService as jest.MockedClass<typeof DriveCryptoService>;
const MockedHTTPClientAdapter = HTTPClientAdapter as jest.MockedClass<typeof HTTPClientAdapter>;

describe('createSDKClient', () => {
  const singlePasswordSession = {
    sessionId: 'uid-1',
    uid: 'uid-1',
    accessToken: 'access',
    refreshToken: 'refresh',
    scopes: ['full'],
    passwordMode: 1,
  };

  const browserForkSession = {
    ...singlePasswordSession,
    authMode: 'browser-fork' as const,
    keyPasswordPersisted: true,
    keyPasswordProvider: 'git-credential' as const,
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionManager.loadSession.mockResolvedValue(null);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(singlePasswordSession as any);
    mockDriveCryptoInitialize.mockResolvedValue(undefined);
    mockDriveCryptoInitializeWithUserKeyPassword.mockResolvedValue(undefined);
    mockKeyPasswordLoad.mockResolvedValue('stored-user-key-password');
  });

  it('uses an explicit data password to unlock an existing session', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(singlePasswordSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({ dataPassword: 'mailbox-password' });

    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
    expect(mockDriveCryptoInitializeWithUserKeyPassword).not.toHaveBeenCalled();
  });

  it('uses stored browser-fork key password when no data password is supplied', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(browserForkSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({});

    expect(mockKeyPasswordLoad).toHaveBeenCalledWith('uid-1');
    expect(mockDriveCryptoInitializeWithUserKeyPassword)
      .toHaveBeenCalledWith('stored-user-key-password');
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('uses stored browser-fork key password even for two-password sessions', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({
      ...browserForkSession,
      passwordMode: 2,
    } as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({});

    expect(mockKeyPasswordLoad).toHaveBeenCalledWith('uid-1');
    expect(mockDriveCryptoInitializeWithUserKeyPassword)
      .toHaveBeenCalledWith('stored-user-key-password');
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('lets an explicit data password override browser-fork key-password lookup', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(browserForkSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({ dataPassword: 'mailbox-password' });

    expect(mockKeyPasswordLoad).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
    expect(mockDriveCryptoInitializeWithUserKeyPassword).not.toHaveBeenCalled();
  });

  it('fails existing browser-fork sessions when stored key password is missing', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(browserForkSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);
    mockKeyPasswordLoad.mockResolvedValue(undefined);

    await expect(createSDKClient({})).rejects.toMatchObject({
      code: ErrorCode.KEY_PASSWORD_REQUIRED,
    });

    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitializeWithUserKeyPassword).not.toHaveBeenCalled();
  });

  it('requires data password for non-browser-fork two-password sessions', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({
      ...singlePasswordSession,
      passwordMode: 2,
    } as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await expect(createSDKClient({})).rejects.toMatchObject({
      code: ErrorCode.DATA_PASSWORD_REQUIRED,
    });
  });

  it('refreshes an expired saved session and then initializes crypto', async () => {
    const expiredSession = { ...singlePasswordSession, accessToken: 'old-access' };
    const refreshedSession = { ...singlePasswordSession, accessToken: 'new-access' };
    mockedSessionManager.loadSession.mockResolvedValue(expiredSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshedSession as any);

    await createSDKClient({ dataPassword: 'mailbox-password' });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(expiredSession, undefined);
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
  });

  it('fails closed when no browser-fork session exists', async () => {
    await expect(createSDKClient({ dataPassword: 'mailbox-password' }))
      .rejects.toMatchObject({
        code: ErrorCode.SESSION_EXPIRED,
        details: { authMode: 'browser-fork' },
      });
  });

  it('passes appVersion into refresh, crypto, and HTTP adapters', async () => {
    const expiredSession = { ...singlePasswordSession, accessToken: 'old-access' };
    const refreshedSession = { ...singlePasswordSession, accessToken: 'new-access' };
    mockedSessionManager.loadSession.mockResolvedValue(expiredSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshedSession as any);

    await createSDKClient({
      dataPassword: 'mailbox-password',
      appVersion: 'external-drive-root@9.9.9',
    });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(
      expiredSession,
      'external-drive-root@9.9.9',
    );
    expect(MockedDriveCryptoService).toHaveBeenCalledWith('external-drive-root@9.9.9');
    expect(MockedHTTPClientAdapter).toHaveBeenCalledWith('external-drive-root@9.9.9');
  });
});
