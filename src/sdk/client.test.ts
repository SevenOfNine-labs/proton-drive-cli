const mockDriveCryptoInitialize = jest.fn();

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
    keyPassword: 'stored-user-key-password',
    scopes: ['full'],
    credentialStore: 'git-credential' as const,
    credentialHost: 'proton-drive-cli.invalid',
    revision: 'rev-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedSessionManager.loadSession.mockResolvedValue(session);
    mockedSessionManager.validateSession.mockResolvedValue(true);
    mockedSessionManager.refreshSessionOrAdoptRotated.mockResolvedValue({ ...session, accessToken: 'refreshed' });
    mockDriveCryptoInitialize.mockResolvedValue(undefined);
  });

  it('unlocks the account keys with the key password of the session entry', async () => {
    await createSDKClient({});

    expect(mockedSessionManager.loadSession).toHaveBeenCalledTimes(1);
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('stored-user-key-password');
    expect(mockedSessionManager.refreshSessionOrAdoptRotated).not.toHaveBeenCalled();
  });

  it('keeps CREDENTIALS_UNAVAILABLE when the credential store cannot return the session entry', async () => {
    const unavailable = new AppError(
      'The credentials of the session could not be read from git-credential (git credential fill failed)',
      ErrorCode.CREDENTIALS_UNAVAILABLE,
      { credentialStore: 'git-credential', credentialHost: 'proton-drive-cli.invalid', storeError: 'git credential fill failed' },
      true,
    );
    mockedSessionManager.loadSession.mockRejectedValue(unavailable);

    await expect(createSDKClient({})).rejects.toBe(unavailable);
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
  });

  it('unlocks the keys with the key password of the refreshed session', async () => {
    mockedSessionManager.validateSession.mockResolvedValue(false);
    mockedSessionManager.refreshSessionOrAdoptRotated.mockResolvedValue({ ...session, keyPassword: 'refreshed-entry-key-password' });

    await createSDKClient({});

    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('refreshed-entry-key-password');
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
