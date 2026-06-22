const mockDriveCryptoInitialize = jest.fn();
const mockDriveCryptoInitializeWithUserKeyPassword = jest.fn();
const mockAuthLogin = jest.fn();
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

jest.mock('../auth', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    login: mockAuthLogin,
  })),
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    loadSession: jest.fn(),
    hasValidSession: jest.fn(),
    saveSession: jest.fn(),
    refreshSession: jest.fn(),
  },
}));

jest.mock('../api/auth', () => ({
  AuthApiClient: jest.fn().mockImplementation(() => ({
    refreshToken: jest.fn(),
  })),
}));

jest.mock('../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { ErrorCode } from '../errors/types';
import { SessionManager } from '../auth/session';
import { AuthService } from '../auth';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { HTTPClientAdapter } from './httpClientAdapter';
import { createSDKClient } from './client';

const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const MockedAuthService = AuthService as jest.MockedClass<typeof AuthService>;
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

  const twoPasswordSession = {
    ...singlePasswordSession,
    passwordMode: 2,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionManager.loadSession.mockResolvedValue(null);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.saveSession.mockResolvedValue(undefined);
    mockedSessionManager.refreshSession.mockResolvedValue(singlePasswordSession as any);
    mockDriveCryptoInitialize.mockResolvedValue(undefined);
    mockDriveCryptoInitializeWithUserKeyPassword.mockResolvedValue(undefined);
    mockKeyPasswordLoad.mockResolvedValue('stored-user-key-password');
    mockAuthLogin.mockResolvedValue(singlePasswordSession);
  });

  it('uses the provided data password to unlock an existing session', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(singlePasswordSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({
      dataPassword: 'mailbox-password',
      allowLogin: false,
    });

    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('uses stored browser-fork key password to unlock an existing fork session', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({
      ...singlePasswordSession,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordProvider: 'git-credential',
      keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
    } as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({
      allowLogin: false,
    });

    expect(mockKeyPasswordLoad).toHaveBeenCalledWith('uid-1');
    expect(mockDriveCryptoInitializeWithUserKeyPassword).toHaveBeenCalledWith('stored-user-key-password');
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('allows explicit data password to override browser-fork key password lookup', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({
      ...singlePasswordSession,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
    } as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({
      dataPassword: 'mailbox-password',
      allowLogin: false,
    });

    expect(mockKeyPasswordLoad).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
    expect(mockDriveCryptoInitializeWithUserKeyPassword).not.toHaveBeenCalled();
  });

  it('fails existing browser-fork sessions when the stored key password is missing', async () => {
    mockedSessionManager.loadSession.mockResolvedValue({
      ...singlePasswordSession,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
    } as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);
    mockKeyPasswordLoad.mockResolvedValue(undefined);

    await expect(createSDKClient({
      allowLogin: false,
    })).rejects.toMatchObject({
      code: ErrorCode.KEY_PASSWORD_REQUIRED,
    });

    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitializeWithUserKeyPassword).not.toHaveBeenCalled();
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('does not fall back to SRP login when key unlock fails for an existing session', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(singlePasswordSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);
    mockDriveCryptoInitialize.mockRejectedValue(new Error('Failed to decrypt any keys'));

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'wrong-data-password',
    })).rejects.toThrow('Failed to decrypt any keys');

    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('uses login password for SRP and data password for key unlock', async () => {
    mockAuthLogin.mockResolvedValue(twoPasswordSession);

    await createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: '123456',
    });

    expect(mockAuthLogin).toHaveBeenCalledWith('user@proton.me', 'login-password', {
      secondFactorCode: '123456',
    });
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
  });

  it('requires explicit data password after login for two-password accounts', async () => {
    mockAuthLogin.mockResolvedValue(twoPasswordSession);

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
    })).rejects.toMatchObject({
      code: ErrorCode.DATA_PASSWORD_REQUIRED,
    });

    expect(mockAuthLogin).toHaveBeenCalled();
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('requires explicit data password for existing two-password sessions in options mode', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(twoPasswordSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
    })).rejects.toMatchObject({
      code: ErrorCode.DATA_PASSWORD_REQUIRED,
    });

    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('uses SessionManager.refreshSession for expired saved sessions', async () => {
    const expiredSession = {
      ...singlePasswordSession,
      accessToken: 'old-access',
    };
    const refreshedSession = {
      ...singlePasswordSession,
      accessToken: 'new-access',
    };
    mockedSessionManager.loadSession.mockResolvedValue(expiredSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshedSession as any);

    await createSDKClient({
      dataPassword: 'mailbox-password',
      allowLogin: false,
    });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(expiredSession, undefined);
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('passes appVersion into SDK HTTP, crypto, and refresh clients', async () => {
    const expiredSession = {
      ...singlePasswordSession,
      accessToken: 'old-access',
    };
    const refreshedSession = {
      ...singlePasswordSession,
      accessToken: 'new-access',
    };
    mockedSessionManager.loadSession.mockResolvedValue(expiredSession as any);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshedSession as any);

    await createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      appVersion: 'external-drive-root@9.9.9',
    });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(
      expiredSession,
      'external-drive-root@9.9.9'
    );
    expect(MockedDriveCryptoService).toHaveBeenCalledWith('external-drive-root@9.9.9');
    expect(MockedHTTPClientAdapter).toHaveBeenCalledWith('external-drive-root@9.9.9');
    expect(MockedAuthService).not.toHaveBeenCalled();
  });

  it('passes appVersion into AuthService for full login', async () => {
    await createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      appVersion: 'external-drive-root@9.9.9',
    });

    expect(MockedAuthService).toHaveBeenCalledWith(
      undefined,
      'external-drive-root@9.9.9'
    );
    expect(mockAuthLogin).toHaveBeenCalledWith('user@proton.me', 'login-password', {
      secondFactorCode: undefined,
    });
    expect(MockedHTTPClientAdapter).toHaveBeenCalledWith('external-drive-root@9.9.9');
  });
});
