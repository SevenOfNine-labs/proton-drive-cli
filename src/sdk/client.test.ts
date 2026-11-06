const mockDriveCryptoInitialize = jest.fn();
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

jest.mock('./telemetry', () => ({
  createSdkTelemetry: jest.fn(() => ({ getLogger: jest.fn(), recordMetric: jest.fn() })),
}));

jest.mock('../crypto/drive-crypto', () => ({
  DriveCryptoService: jest.fn().mockImplementation(() => ({
    initialize: mockDriveCryptoInitialize,
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
    validateSession: jest.fn(),
    refreshSessionOrAdoptRotated: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AppError, ErrorCode, RateLimitError } from '../errors/types';
import { SessionManager } from '../auth/session';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { HTTPClientAdapter } from './httpClientAdapter';
import { createSDKClient } from './client';

const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const MockedDriveCryptoService = DriveCryptoService as jest.MockedClass<typeof DriveCryptoService>;
const MockedHTTPClientAdapter = HTTPClientAdapter as jest.MockedClass<typeof HTTPClientAdapter>;

describe('createSDKClient', () => {
  const session = {
    uid: 'uid-1',
    accessToken: 'access',
    refreshToken: 'refresh',
    scopes: ['full'],
    keyPasswordProvider: 'git-credential' as const,
    keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionManager.loadSession.mockResolvedValue(session);
    mockedSessionManager.validateSession.mockResolvedValue(true);
    mockedSessionManager.refreshSessionOrAdoptRotated.mockResolvedValue({ ...session, accessToken: 'refreshed' });
    mockDriveCryptoInitialize.mockResolvedValue(undefined);
    mockKeyPasswordLoad.mockResolvedValue('stored-user-key-password');
  });

  it('unlocks the account keys with the stored browser-fork key password', async () => {
    await createSDKClient({});

    const { createKeyPasswordStore } = jest.requireMock('../auth/key-password-store');
    expect(createKeyPasswordStore).toHaveBeenCalledWith({
      provider: 'git-credential',
      host: 'proton-drive-key.proton-lfs-cli.local',
    });
    expect(mockKeyPasswordLoad).toHaveBeenCalledWith('uid-1');
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('stored-user-key-password');
    expect(mockedSessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
  });

  it('fails with KEY_PASSWORD_REQUIRED carrying the provider reason when the key password is unavailable', async () => {
    mockKeyPasswordLoad.mockRejectedValue(new Error('pass-cli is not logged in. Run: pass-cli login'));

    await expect(createSDKClient({})).rejects.toMatchObject({
      code: ErrorCode.KEY_PASSWORD_REQUIRED,
      message: expect.stringContaining('pass-cli is not logged in'),
      details: {
        keyPasswordProvider: 'git-credential',
        keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
        providerError: 'pass-cli is not logged in. Run: pass-cli login',
      },
    });
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('refreshes a locally expired session before unlocking the keys', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);

    await createSDKClient({});

    expect(mockedSessionManager.refreshSessionOrAdoptRotated).toHaveBeenCalledWith(session, undefined);
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('stored-user-key-password');
  });

  it('keeps the code of a refresh failure a later attempt can overcome', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);
    const rateLimited = new RateLimitError('Too many requests', { retryAfter: 30, protonCode: 2028 });
    mockedSessionManager.refreshSessionOrAdoptRotated.mockRejectedValue(rateLimited);

    await expect(createSDKClient({})).rejects.toBe(rateLimited);
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('propagates the sign-out of a rejected refresh token', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);
    const signedOut = new AppError('signed out', ErrorCode.SESSION_EXPIRED, { signedOut: true }, false);
    mockedSessionManager.refreshSessionOrAdoptRotated.mockRejectedValue(signedOut);

    await expect(createSDKClient({})).rejects.toBe(signedOut);
  });

  it('fails closed when no browser-fork session exists', async () => {
    mockedSessionManager.loadSession.mockResolvedValue(null);

    await expect(createSDKClient({})).rejects.toMatchObject({ code: ErrorCode.SESSION_EXPIRED });
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('passes appVersion into refresh, crypto, and HTTP adapters', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);

    await createSDKClient({ appVersion: 'external-drive-root@9.9.9' });

    expect(mockedSessionManager.refreshSessionOrAdoptRotated).toHaveBeenCalledWith(session, 'external-drive-root@9.9.9');
    expect(MockedDriveCryptoService).toHaveBeenCalledWith('external-drive-root@9.9.9');
    expect(MockedHTTPClientAdapter).toHaveBeenCalledWith('external-drive-root@9.9.9');
  });

  it('hands the SDK a telemetry adapter so it never logs to stdout', async () => {
    const { ProtonDriveClient } = jest.requireMock('@protontech/drive-sdk');
    const { createSdkTelemetry } = jest.requireMock('./telemetry');

    await createSDKClient({});

    expect(createSdkTelemetry).toHaveBeenCalledTimes(1);
    expect(ProtonDriveClient).toHaveBeenCalledWith(expect.objectContaining({
      telemetry: expect.objectContaining({ getLogger: expect.any(Function), recordMetric: expect.any(Function) }),
    }));
  });
});
