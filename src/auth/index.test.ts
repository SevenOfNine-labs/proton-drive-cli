import { AuthApiClient } from '../api/auth';
import { HttpClientError } from '../api/http-client';
import { ErrorCode } from '../errors/types';
import { AuthResponse } from '../types/auth';
import { AuthService } from './index';
import { SessionManager } from './session';
import { SRPClient } from './srp';

jest.mock('../api/auth', () => ({
  AuthApiClient: jest.fn(),
}));

jest.mock('./session', () => ({
  SessionManager: {
    saveSession: jest.fn(),
    loadSession: jest.fn(),
    clearSession: jest.fn(),
    clearCryptoCache: jest.fn(),
    hasValidSession: jest.fn(),
    hashUsername: jest.fn(),
    getSessionFilePath: jest.fn(),
  },
}));

jest.mock('./srp', () => ({
  SRPClient: {
    computeHandshake: jest.fn(),
    verifyServerProof: jest.fn(),
  },
}));

const MockedAuthApiClient = AuthApiClient as jest.MockedClass<typeof AuthApiClient>;
const mockedSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const mockedSRPClient = SRPClient as jest.Mocked<typeof SRPClient>;

describe('AuthService', () => {
  const getAuthInfo = jest.fn();
  const authenticate = jest.fn();
  const complete2FA = jest.fn();
  const refreshToken = jest.fn();
  const logout = jest.fn();

  const baseAuthResponse: AuthResponse = {
    UID: 'uid-123',
    AccessToken: 'access-token',
    RefreshToken: 'refresh-token',
    TokenType: 'Bearer',
    Scopes: ['full'],
    ServerProof: 'server-proof',
    PasswordMode: 1,
    '2FA': {
      Enabled: 0,
      FIDO2: { RegisteredKeys: [] },
      TOTP: 0,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    getAuthInfo.mockResolvedValue({
      Modulus: 'modulus',
      ServerEphemeral: 'server-ephemeral',
      Version: 4,
      Salt: 'salt',
      SRPSession: 'srp-session',
    });
    authenticate.mockResolvedValue(baseAuthResponse);
    complete2FA.mockResolvedValue(undefined);

    MockedAuthApiClient.mockImplementation(() => ({
      getAuthInfo,
      authenticate,
      complete2FA,
      refreshToken,
      logout,
    } as unknown as AuthApiClient));

    mockedSRPClient.computeHandshake.mockResolvedValue({
      clientEphemeral: 'client-ephemeral',
      clientProof: 'client-proof',
      expectedServerProof: 'server-proof',
    });
    mockedSRPClient.verifyServerProof.mockReturnValue(true);

    mockedSessionManager.hashUsername.mockReturnValue('user-hash');
    mockedSessionManager.getSessionFilePath.mockReturnValue('/tmp/session.json');
    mockedSessionManager.saveSession.mockResolvedValue(undefined);
  });

  it('saves a session when no second factor is required', async () => {
    const service = new AuthService();

    const session = await service.login('user@proton.me', 'login-password');

    expect(complete2FA).not.toHaveBeenCalled();
    expect(mockedSessionManager.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'uid-123',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        passwordMode: 1,
        userHash: 'user-hash',
      })
    );
    expect(session.uid).toBe('uid-123');
  });

  it('does not persist a session when TOTP is required but missing', async () => {
    authenticate.mockResolvedValue({
      ...baseAuthResponse,
      '2FA': {
        Enabled: 1,
        FIDO2: { RegisteredKeys: [] },
        TOTP: 1,
      },
    });
    const service = new AuthService();

    await expect(service.login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_REQUIRED,
        details: expect.objectContaining({ twoFactorType: 'totp' }),
      });

    expect(complete2FA).not.toHaveBeenCalled();
    expect(mockedSessionManager.saveSession).not.toHaveBeenCalled();
  });

  it('completes TOTP before persisting the session', async () => {
    authenticate.mockResolvedValue({
      ...baseAuthResponse,
      '2FA': {
        Enabled: 1,
        FIDO2: { RegisteredKeys: [] },
        TOTP: 1,
      },
    });
    const service = new AuthService();

    await service.login('user@proton.me', 'login-password', {
      secondFactorCode: '123456',
    });

    expect(complete2FA).toHaveBeenCalledWith(
      'uid-123',
      'access-token',
      { TwoFactorCode: '123456' }
    );
    expect(mockedSessionManager.saveSession).toHaveBeenCalled();
  });

  it('stops on FIDO2-only accounts without persisting the session', async () => {
    authenticate.mockResolvedValue({
      ...baseAuthResponse,
      '2FA': {
        Enabled: 2,
        FIDO2: { RegisteredKeys: [{ keyHandle: 'key', publicKey: 'pub' }] },
        TOTP: 0,
      },
    });
    const service = new AuthService();

    await expect(service.login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_REQUIRED,
        details: expect.objectContaining({ twoFactorType: 'fido2' }),
      });

    expect(complete2FA).not.toHaveBeenCalled();
    expect(mockedSessionManager.saveSession).not.toHaveBeenCalled();
  });

  it('labels auth-info timeout failures without persisting the session', async () => {
    getAuthInfo.mockRejectedValue(new HttpClientError('Request timed out', {
      code: 'ECONNABORTED',
    }));
    const service = new AuthService();

    await expect(service.login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.TIMEOUT,
        message: 'Login failed during auth-info: Request timed out',
        details: expect.objectContaining({
          authStage: 'auth-info',
          endpoint: '/auth/v4/info',
          clientCode: 'ECONNABORTED',
        }),
      });

    expect(authenticate).not.toHaveBeenCalled();
    expect(mockedSessionManager.saveSession).not.toHaveBeenCalled();
  });

  it('labels auth-submit API failures without persisting the session', async () => {
    authenticate.mockRejectedValue(new HttpClientError('Request failed with status 401', {
      response: {
        data: { Code: 8002, Error: 'Invalid login credentials' },
        status: 401,
        headers: {},
        config: {},
      },
    }));
    const service = new AuthService();

    await expect(service.login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.AUTH_FAILED,
        message: 'Login failed during auth-submit: Request failed with status 401',
        details: expect.objectContaining({
          authStage: 'auth-submit',
          endpoint: '/auth/v4',
          httpStatus: 401,
          protonCode: 8002,
          apiMessage: 'Invalid login credentials',
        }),
      });

    expect(mockedSessionManager.saveSession).not.toHaveBeenCalled();
  });
});
