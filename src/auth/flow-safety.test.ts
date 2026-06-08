import type { AuthResponse, SessionCredentials } from '../types/auth';

function makeSession(overrides: Partial<SessionCredentials> = {}): SessionCredentials {
  return {
    sessionId: 'session-1',
    uid: 'uid-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    scopes: ['full'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    userHash: 'user-hash',
    ...overrides,
  };
}

function makeAuthResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
  return {
    UID: 'uid-1',
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
    ...overrides,
  };
}

function clearHarnessMocks() {
  jest.dontMock('@protontech/drive-sdk');
  jest.dontMock('fs-extra');
  jest.dontMock('../api/auth');
  jest.dontMock('../api/user');
  jest.dontMock('../cli/bridge');
  jest.dontMock('../credentials');
  jest.dontMock('../crypto/drive-crypto');
  jest.dontMock('../sdk/accountAdapter');
  jest.dontMock('../sdk/client');
  jest.dontMock('../sdk/cryptoProxy');
  jest.dontMock('../sdk/httpClientAdapter');
  jest.dontMock('../sdk/srpAdapter');
  jest.dontMock('../utils/logger');
  jest.dontMock('./index');
  jest.dontMock('./session');
  jest.dontMock('./srp');
}

async function loadSDKHarness() {
  jest.resetModules();
  clearHarnessMocks();

  const mockDriveCryptoInitialize = jest.fn().mockResolvedValue(undefined);
  const mockAuthLogin = jest.fn().mockResolvedValue(makeSession());
  const mockedSessionManager = {
    loadSession: jest.fn().mockResolvedValue(null),
    hasValidSession: jest.fn().mockResolvedValue(false),
    saveSession: jest.fn().mockResolvedValue(undefined),
    refreshSession: jest.fn().mockResolvedValue(makeSession()),
  };

  jest.doMock('@protontech/drive-sdk', () => ({
    ProtonDriveClient: jest.fn().mockImplementation((args: unknown) => ({ args })),
    MemoryCache: jest.fn().mockImplementation(() => ({})),
    OpenPGPCryptoWithCryptoProxy: jest.fn().mockImplementation(() => ({})),
  }));
  jest.doMock('../sdk/cryptoProxy', () => ({
    ProtonOpenPGPCryptoProxy: jest.fn().mockImplementation(() => ({})),
  }));
  jest.doMock('../sdk/httpClientAdapter', () => ({
    HTTPClientAdapter: jest.fn().mockImplementation(() => ({})),
  }));
  jest.doMock('../sdk/accountAdapter', () => ({
    AccountAdapter: jest.fn().mockImplementation(() => ({})),
  }));
  jest.doMock('../sdk/srpAdapter', () => ({
    SRPModuleAdapter: jest.fn().mockImplementation(() => ({})),
  }));
  jest.doMock('../crypto/drive-crypto', () => ({
    DriveCryptoService: jest.fn().mockImplementation(() => ({
      initialize: mockDriveCryptoInitialize,
    })),
  }));
  jest.doMock('./index', () => ({
    AuthService: jest.fn().mockImplementation(() => ({
      login: mockAuthLogin,
    })),
  }));
  jest.doMock('./session', () => ({
    SessionManager: mockedSessionManager,
  }));
  jest.doMock('../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  const { createSDKClient } = await import('../sdk/client');
  const { ErrorCode } = await import('../errors/types');

  return {
    createSDKClient,
    ErrorCode,
    mockAuthLogin,
    mockDriveCryptoInitialize,
    mockedSessionManager,
  };
}

async function loadAuthServiceHarness() {
  jest.resetModules();
  clearHarnessMocks();

  const getAuthInfo = jest.fn().mockResolvedValue({
    Modulus: 'modulus',
    ServerEphemeral: 'server-ephemeral',
    Version: 4,
    Salt: 'salt',
    SRPSession: 'srp-session',
  });
  const authenticate = jest.fn().mockResolvedValue(makeAuthResponse());
  const complete2FA = jest.fn().mockResolvedValue(undefined);
  const saveSession = jest.fn().mockResolvedValue(undefined);

  jest.doMock('../api/auth', () => ({
    AuthApiClient: jest.fn().mockImplementation(() => ({
      getAuthInfo,
      authenticate,
      complete2FA,
      refreshToken: jest.fn(),
      logout: jest.fn(),
    })),
  }));
  jest.doMock('./session', () => ({
    SessionManager: {
      saveSession,
      loadSession: jest.fn(),
      clearSession: jest.fn(),
      clearCryptoCache: jest.fn(),
      hasValidSession: jest.fn(),
      hashUsername: jest.fn().mockReturnValue('user-hash'),
      getSessionFilePath: jest.fn().mockReturnValue('/tmp/session.json'),
      refreshSession: jest.fn(),
    },
  }));
  jest.doMock('./srp', () => ({
    SRPClient: {
      computeHandshake: jest.fn().mockResolvedValue({
        clientEphemeral: 'client-ephemeral',
        clientProof: 'client-proof',
        expectedServerProof: 'server-proof',
      }),
      verifyServerProof: jest.fn().mockReturnValue(true),
    },
  }));
  jest.doMock('../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  const { AuthService } = await import('./index');
  const { CaptchaError, ErrorCode } = await import('../errors/types');
  const { HttpClientError } = await import('../api/http-client');

  return {
    AuthService,
    CaptchaError,
    ErrorCode,
    HttpClientError,
    authenticate,
    complete2FA,
    getAuthInfo,
    saveSession,
  };
}

async function loadSessionHarness() {
  jest.resetModules();
  clearHarnessMocks();

  const mockRefreshToken = jest.fn();
  const mockFs = {
    ensureDir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn(),
    pathExists: jest.fn().mockResolvedValue(true),
    readJson: jest.fn(),
    writeJson: jest.fn().mockResolvedValue(undefined),
    move: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  jest.doMock('fs-extra', () => mockFs);
  jest.doMock('../api/auth', () => ({
    AuthApiClient: jest.fn().mockImplementation(() => ({
      refreshToken: mockRefreshToken,
    })),
  }));
  jest.doMock('../api/user', () => ({
    UserApiClient: jest.fn().mockImplementation(() => ({
      getUser: jest.fn(),
    })),
  }));
  jest.doMock('../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));

  const { SessionManager } = await import('./session');

  return { SessionManager, mockFs, mockRefreshToken };
}

async function loadBridgeHarness() {
  jest.resetModules();
  clearHarnessMocks();

  const mockCreateSDKClient = jest.fn().mockResolvedValue({});
  const mockCredentialResolve = jest.fn();
  const mockCreateProvider = jest.fn().mockImplementation(() => ({
    resolve: mockCredentialResolve,
  }));

  jest.doMock('../sdk/client', () => ({
    createSDKClient: mockCreateSDKClient,
  }));
  jest.doMock('../credentials', () => ({
    createProvider: mockCreateProvider,
    normalizeProviderName: jest.fn((name: string) => name),
  }));

  const { getInitializedClient } = await import('../cli/bridge');

  return {
    getInitializedClient,
    mockCreateProvider,
    mockCreateSDKClient,
    mockCredentialResolve,
  };
}

async function loadRetryHarness() {
  jest.resetModules();
  clearHarnessMocks();
  jest.doMock('../utils/logger', () => ({
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  return import('../utils/retry');
}

describe('offline auth flow safety gate', () => {
  afterEach(() => {
    clearHarnessMocks();
  });

  it('reuses a valid saved session without SRP login', async () => {
    const {
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
      mockedSessionManager,
    } = await loadSDKHarness();
    const session = makeSession();
    mockedSessionManager.loadSession.mockResolvedValue(session);
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await createSDKClient({ dataPassword: 'mailbox-password', allowLogin: false });

    expect(mockedSessionManager.refreshSession).not.toHaveBeenCalled();
    expect(mockAuthLogin).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
  });

  it('refreshes an expired session once before unlocking keys', async () => {
    const {
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
      mockedSessionManager,
    } = await loadSDKHarness();
    const expired = makeSession({ accessToken: 'old-access' });
    const refreshed = makeSession({ accessToken: 'new-access' });
    mockedSessionManager.loadSession.mockResolvedValue(expired);
    mockedSessionManager.hasValidSession.mockResolvedValue(false);
    mockedSessionManager.refreshSession.mockResolvedValue(refreshed);

    await createSDKClient({ dataPassword: 'mailbox-password', allowLogin: false });

    expect(mockedSessionManager.refreshSession).toHaveBeenCalledTimes(1);
    expect(mockedSessionManager.refreshSession).toHaveBeenCalledWith(expired);
    expect(mockAuthLogin).not.toHaveBeenCalled();
    expect(mockDriveCryptoInitialize).toHaveBeenCalledWith('mailbox-password');
  });

  it('does not consume a stale refresh token when another process already refreshed', async () => {
    const { SessionManager, mockFs, mockRefreshToken } = await loadSessionHarness();
    const stale = makeSession({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenExpiresAt: Date.now() + 4 * 60 * 1000,
    });
    const alreadyRefreshed = makeSession({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    mockFs.readJson.mockResolvedValue(alreadyRefreshed);

    const result = await SessionManager.refreshSession(stale);

    expect(result).toEqual(alreadyRefreshed);
    expect(mockRefreshToken).not.toHaveBeenCalled();
    expect(mockFs.writeJson).not.toHaveBeenCalled();
  });

  it('never falls back to SRP login after key unlock failure', async () => {
    const {
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
      mockedSessionManager,
    } = await loadSDKHarness();
    mockedSessionManager.loadSession.mockResolvedValue(makeSession());
    mockedSessionManager.hasValidSession.mockResolvedValue(true);
    mockDriveCryptoInitialize.mockRejectedValue(new Error('Failed to decrypt any keys'));

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'wrong-mailbox-password',
    })).rejects.toThrow('Failed to decrypt any keys');

    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('requires an explicit mailbox/data password for two-password sessions', async () => {
    const {
      ErrorCode,
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
      mockedSessionManager,
    } = await loadSDKHarness();
    mockedSessionManager.loadSession.mockResolvedValue(makeSession({ passwordMode: 2 }));
    mockedSessionManager.hasValidSession.mockResolvedValue(true);

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
    })).rejects.toMatchObject({ code: ErrorCode.DATA_PASSWORD_REQUIRED });

    expect(mockDriveCryptoInitialize).not.toHaveBeenCalled();
    expect(mockAuthLogin).not.toHaveBeenCalled();
  });

  it('does not reuse the login password as the data password after two-password login', async () => {
    const {
      ErrorCode,
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
    } = await loadSDKHarness();
    mockAuthLogin.mockResolvedValue(makeSession({ passwordMode: 2 }));

    await expect(createSDKClient({
      username: 'user@proton.me',
      loginPassword: 'login-password',
    })).rejects.toMatchObject({ code: ErrorCode.DATA_PASSWORD_REQUIRED });

    expect(mockAuthLogin).toHaveBeenCalledTimes(1);
    expect(mockDriveCryptoInitialize).not.toHaveBeenCalledWith('login-password');
  });

  it('uses separate login and mailbox/data passwords for full login', async () => {
    const {
      createSDKClient,
      mockAuthLogin,
      mockDriveCryptoInitialize,
    } = await loadSDKHarness();
    mockAuthLogin.mockResolvedValue(makeSession({ passwordMode: 2 }));

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

  it('does not persist a session when TOTP is required but missing', async () => {
    const {
      AuthService,
      ErrorCode,
      authenticate,
      complete2FA,
      saveSession,
    } = await loadAuthServiceHarness();
    authenticate.mockResolvedValue(makeAuthResponse({
      '2FA': {
        Enabled: 1,
        FIDO2: { RegisteredKeys: [] },
        TOTP: 1,
      },
    }));

    await expect(new AuthService().login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_REQUIRED,
        details: expect.objectContaining({ twoFactorType: 'totp' }),
      });

    expect(complete2FA).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('completes TOTP before persisting a session', async () => {
    const {
      AuthService,
      authenticate,
      complete2FA,
      saveSession,
    } = await loadAuthServiceHarness();
    authenticate.mockResolvedValue(makeAuthResponse({
      '2FA': {
        Enabled: 1,
        FIDO2: { RegisteredKeys: [] },
        TOTP: 1,
      },
    }));

    await new AuthService().login('user@proton.me', 'login-password', {
      secondFactorCode: '123456',
    });

    expect(complete2FA).toHaveBeenCalledWith('uid-1', 'access-token', {
      TwoFactorCode: '123456',
    });
    expect(complete2FA.mock.invocationCallOrder[0]).toBeLessThan(
      saveSession.mock.invocationCallOrder[0]
    );
  });

  it('stops on FIDO2-only 2FA without persisting a session', async () => {
    const {
      AuthService,
      ErrorCode,
      authenticate,
      complete2FA,
      saveSession,
    } = await loadAuthServiceHarness();
    authenticate.mockResolvedValue(makeAuthResponse({
      '2FA': {
        Enabled: 2,
        FIDO2: { RegisteredKeys: [{ keyHandle: 'key', publicKey: 'pub' }] },
        TOTP: 0,
      },
    }));

    await expect(new AuthService().login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_REQUIRED,
        details: expect.objectContaining({ twoFactorType: 'fido2' }),
      });

    expect(complete2FA).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('surfaces rate limits as one-shot user-action failures', async () => {
    const {
      AuthService,
      ErrorCode,
      HttpClientError,
      authenticate,
      getAuthInfo,
      saveSession,
    } = await loadAuthServiceHarness();
    getAuthInfo.mockRejectedValue(new HttpClientError('too many requests', {
      response: {
        data: { Code: 2028, Error: 'Too many requests' },
        status: 429,
        headers: {},
        config: {},
      },
    }));

    await expect(new AuthService().login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: ErrorCode.RATE_LIMITED,
        details: expect.objectContaining({ protonCode: 2028 }),
      });

    expect(getAuthInfo).toHaveBeenCalledTimes(1);
    expect(authenticate).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('surfaces CAPTCHA as a one-shot user-action failure', async () => {
    const {
      AuthService,
      CaptchaError,
      getAuthInfo,
      saveSession,
    } = await loadAuthServiceHarness();
    getAuthInfo.mockRejectedValue(new CaptchaError({
      captchaUrl: 'https://verify.proton.me/captcha',
      captchaToken: 'hvt-token',
    }));

    await expect(new AuthService().login('user@proton.me', 'login-password'))
      .rejects.toMatchObject({
        code: 'CAPTCHA_REQUIRED',
        captchaToken: 'hvt-token',
      });

    expect(getAuthInfo).toHaveBeenCalledTimes(1);
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('resolves login and mailbox/data credentials as separate bridge inputs', async () => {
    const {
      getInitializedClient,
      mockCreateProvider,
      mockCreateSDKClient,
      mockCredentialResolve,
    } = await loadBridgeHarness();
    mockCredentialResolve
      .mockResolvedValueOnce({
        username: 'provider@proton.me',
        password: 'login-password',
      })
      .mockResolvedValueOnce({
        username: 'provider@proton.me',
        password: 'mailbox-password',
      });

    await getInitializedClient({
      credentialProvider: 'git-credential',
      dataCredentialProvider: 'git-credential',
    });

    expect(mockCreateProvider).toHaveBeenNthCalledWith(1, 'git-credential');
    expect(mockCreateProvider).toHaveBeenNthCalledWith(2, 'git-credential', {
      host: 'proton-data.proton-lfs-cli.local',
    });
    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'provider@proton.me',
      loginPassword: 'login-password',
      dataPassword: 'mailbox-password',
      secondFactorCode: undefined,
      allowLogin: true,
    });
  });

  it('does not turn a login password into an explicit bridge data password', async () => {
    const { getInitializedClient, mockCreateSDKClient } = await loadBridgeHarness();

    await getInitializedClient({
      username: 'user@proton.me',
      password: 'login-password',
    });

    expect(mockCreateSDKClient).toHaveBeenCalledWith({
      username: 'user@proton.me',
      loginPassword: 'login-password',
      dataPassword: undefined,
      secondFactorCode: undefined,
      allowLogin: true,
    });
  });

  it('does not retry CAPTCHA, rate-limit, or permanent auth errors', async () => {
    const { retryWithBackoff } = await loadRetryHarness();
    const config = {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffFactor: 1,
      retryableErrors: new Set<string>(),
    };

    const rateLimited = jest.fn().mockRejectedValue({ response: { status: 429, data: {} } });
    await expect(retryWithBackoff(rateLimited, config, 'rate-limited auth'))
      .rejects.toMatchObject({ response: { status: 429 } });
    expect(rateLimited).toHaveBeenCalledTimes(1);

    const captcha = jest.fn().mockRejectedValue({ response: { data: { Code: 9001 } } });
    await expect(retryWithBackoff(captcha, config, 'captcha auth'))
      .rejects.toMatchObject({ response: { data: { Code: 9001 } } });
    expect(captcha).toHaveBeenCalledTimes(1);

    const unauthorized = jest.fn().mockRejectedValue({ response: { status: 401 } });
    await expect(retryWithBackoff(unauthorized, config, 'unauthorized auth'))
      .rejects.toMatchObject({ response: { status: 401 } });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it('bounds retries for transient failures', async () => {
    const { retryWithBackoff } = await loadRetryHarness();
    const transient = jest.fn().mockRejectedValue(Object.assign(new Error('reset'), {
      code: 'ECONNRESET',
    }));

    await expect(retryWithBackoff(transient, {
      maxAttempts: 3,
      initialDelayMs: 0,
      maxDelayMs: 0,
      backoffFactor: 1,
      retryableErrors: new Set<string>(),
    }, 'transient auth')).rejects.toThrow('reset');

    expect(transient).toHaveBeenCalledTimes(3);
  });
});
