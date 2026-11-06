import {
  createLoginCommand,
  createLogoutCommand,
  createSessionRefreshCommand,
  loginWithBrowserFork,
  resolveBrowserForkKeyPasswordOptions,
} from './login';
import { SessionManager } from '../auth/session';
import { AuthService } from '../auth';
import { HttpClientError } from '../api/http-client';
import { AppError, ErrorCode, RateLimitError } from '../errors/types';

jest.mock('ora', () => jest.fn(() => ({
  start: jest.fn().mockReturnThis(),
  stop: jest.fn(),
  succeed: jest.fn(),
})));

jest.mock('../utils/output', () => ({
  isVerbose: jest.fn(() => false),
  isQuiet: jest.fn(() => false),
  outputResult: jest.fn(),
}));

jest.mock('../utils/open-browser', () => ({
  openBrowserUrl: jest.fn(() => true),
}));

jest.mock('../auth/session', () => ({
  SessionManager: {
    loadSession: jest.fn(),
    readStoredSession: jest.fn(),
    refreshSession: jest.fn(),
  },
}));

import { outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';

const mockOutputResult = outputResult as jest.MockedFunction<typeof outputResult>;
const mockOpenBrowserUrl = openBrowserUrl as jest.MockedFunction<typeof openBrowserUrl>;
const mockSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;
const sessionFields = {
  uid: 'uid-123',
  scopes: ['drive'],
  keyPasswordProvider: 'pass-cli' as const,
  keyPasswordHost: 'proton-drive-key.proton-lfs-cli.local',
};

describe('resolveBrowserForkKeyPasswordOptions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers explicit key-password provider and host', () => {
    expect(resolveBrowserForkKeyPasswordOptions({
      keyPasswordProvider: ' pass-cli ',
      keyPasswordHost: ' proton-drive-key.example.test ',
    })).toEqual({
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.example.test',
    });
  });

  it('uses environment defaults when command options are absent', () => {
    process.env.PROTON_KEY_PASSWORD_PROVIDER = 'pass-cli';
    process.env.PROTON_KEY_PASSWORD_HOST = 'proton-drive-key.env.test';

    expect(resolveBrowserForkKeyPasswordOptions()).toEqual({
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.env.test',
    });
  });

  it('defaults to pass-cli', () => {
    delete process.env.PROTON_KEY_PASSWORD_PROVIDER;
    delete process.env.PROTON_KEY_PASSWORD_HOST;

    expect(resolveBrowserForkKeyPasswordOptions()).toEqual({
      keyPasswordProvider: 'pass-cli',
    });
  });
});

describe('loginWithBrowserFork', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens the browser URL and reports success without printing secrets', async () => {
    const fakeAuthService = {
      login: jest.fn(async ({ onSignInUrl }) => {
        await onSignInUrl('https://account.proton.me/desktop/login?app=drive&pv=3#payload=test');
        return {
          session: { uid: 'uid-123' },
          keyPasswordAvailable: true,
        };
      }),
    } as any;
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await loginWithBrowserFork(fakeAuthService);

    const consoleOutput = logSpy.mock.calls.flat().join('\n');
    expect(fakeAuthService.login).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowserUrl).toHaveBeenCalledWith(
      'https://account.proton.me/desktop/login?app=drive&pv=3#payload=test',
    );
    expect(mockOutputResult).toHaveBeenCalledWith('OK');
    expect(consoleOutput).not.toContain('keyPassword');
  });
});

describe('createLoginCommand', () => {
  it('exposes browser-fork key-password options only', () => {
    const optionNames = createLoginCommand().options.map((option) => option.long);

    expect(optionNames).toEqual(expect.arrayContaining([
      '--key-password-provider',
      '--key-password-host',
    ]));
    expect(optionNames).not.toEqual(expect.arrayContaining([
      '--username',
      '--password-stdin',
      '--credential-provider',
      '--auth-mode',
    ]));
  });
});

describe('createSessionRefreshCommand', () => {
  const originalExit = process.exit;
  const originalLog = console.log;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exit = jest.fn((code?: string | number | null | undefined) => {
      throw new Error(`process.exit:${code}`);
    }) as never;
    console.log = jest.fn();
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    process.exitCode = undefined;
  });

  afterAll(() => {
    process.exitCode = undefined;
  });

  it('emits JSON success without token values', async () => {
    mockSessionManager.loadSession.mockResolvedValue({
      ...sessionFields,
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
    });
    mockSessionManager.refreshSession.mockResolvedValue({
      ...sessionFields,
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenExpiresAt: 1893456000000,
    });

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    expect(mockSessionManager.refreshSession).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'uid-123',
      accessToken: 'old-access-token',
    }));

    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('"ok":true');
    expect(output).toContain('"refreshed":true');
    for (const secret of ['old-access-token', 'old-refresh-token', 'new-access-token', 'new-refresh-token', 'uid-123']) {
      expect(output).not.toContain(secret);
    }
    const parsed = JSON.parse(output);
    expect(parsed.uidFingerprint).toMatch(/^[0-9a-f]{8}$/);
    // first 8 hex chars of sha256("uid-123")
    expect(parsed.uidFingerprint).toBe('23481502');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('exits 0 without output when there is no session', async () => {
    mockSessionManager.loadSession.mockResolvedValue(null);

    await createSessionRefreshCommand().parseAsync(['refresh'], { from: 'user' });

    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('emits a retryable JSON failure with redacted API details while the session stays', async () => {
    mockSessionManager.loadSession.mockResolvedValue({
      ...sessionFields,
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
    });
    mockSessionManager.refreshSession.mockRejectedValue(new HttpClientError(
      'Request failed with status 400',
      {
        response: {
          status: 400,
          headers: {},
          config: {},
          data: {
            Code: 10013,
            Error: 'Invalid refresh token',
            RefreshToken: 'raw-refresh-token',
          },
        },
      },
    ));

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    // The JSON line is written before the exit status is set; process.exit is
    // never called so a pending stdout write cannot be lost.
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: false,
      state: 'refresh_failed',
      errorCode: 'API_ERROR',
      recoverable: true,
      statusCode: 400,
      protonCode: 10013,
      protonError: 'Invalid refresh token',
      action: 'retry_after_backoff',
    });
    expect(output).not.toContain('raw-refresh-token');
    expect(output).not.toContain('uid-123');
  });

  it('reports a rate-limited refresh as retryable with its Retry-After', async () => {
    mockSessionManager.loadSession.mockResolvedValue({ ...sessionFields, accessToken: 'access', refreshToken: 'refresh' });
    mockSessionManager.refreshSession.mockRejectedValue(new RateLimitError('Rate limited', { retryAfter: 120, protonCode: 2028 }));

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    const parsed = JSON.parse((console.log as jest.Mock).mock.calls.flat().join('\n'));
    expect(parsed).toMatchObject({ errorCode: 'RATE_LIMITED', recoverable: true, retryAfter: 120, action: 'retry_after_backoff' });
  });

  it('reports a busy session lock as retryable', async () => {
    mockSessionManager.loadSession.mockResolvedValue({ ...sessionFields, accessToken: 'access', refreshToken: 'refresh' });
    mockSessionManager.refreshSession.mockRejectedValue(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' }));

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    const parsed = JSON.parse((console.log as jest.Mock).mock.calls.flat().join('\n'));
    expect(parsed).toMatchObject({ errorCode: 'TIMEOUT', recoverable: true, action: 'retry_after_backoff' });
  });

  it('reports the sign-out after a rejected refresh token as SESSION_EXPIRED', async () => {
    mockSessionManager.loadSession.mockResolvedValue({
      ...sessionFields,
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
    });
    mockSessionManager.refreshSession.mockRejectedValue(new AppError(
      'Proton rejected the refresh token; the session was signed out. Run: proton-drive-cli login',
      ErrorCode.SESSION_EXPIRED,
      { signedOut: true, statusCode: 400, apiError: { Code: 10013, Error: 'Invalid refresh token' } },
      false,
    ));

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse((console.log as jest.Mock).mock.calls.flat().join('\n'));
    expect(parsed).toMatchObject({
      ok: false,
      state: 'refresh_failed',
      errorCode: 'SESSION_EXPIRED',
      statusCode: 400,
      protonCode: 10013,
      recoverable: false,
    });
    expect(parsed.action).toContain('proton-drive-cli login');
  });
});

describe('createLogoutCommand', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let logout: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    console.log = jest.fn();
    console.error = jest.fn();
    logout = jest.spyOn(AuthService.prototype, 'logout').mockResolvedValue({ revoked: true });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    logout.mockRestore();
    process.exitCode = undefined;
  });

  const printed = (stream: typeof console.log) => (stream as jest.Mock).mock.calls.flat().join('\n');

  it('logs out a session whose access token expired locally', async () => {
    mockSessionManager.readStoredSession.mockResolvedValue({
      kind: 'valid',
      session: { ...sessionFields, accessToken: 'a', refreshToken: 'r', tokenExpiresAt: Date.now() - 60_000 },
    });

    await createLogoutCommand().parseAsync([], { from: 'user' });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(printed(console.log)).toContain('Logged out successfully');
    expect(printed(console.error)).toBe('');
    expect(process.exitCode).toBeUndefined();
  });

  it('warns when the server did not confirm the revocation, after the local cleanup', async () => {
    mockSessionManager.readStoredSession.mockResolvedValue({
      kind: 'valid',
      session: { ...sessionFields, accessToken: 'a', refreshToken: 'r' },
    });
    logout.mockResolvedValue({ revoked: false });

    await createLogoutCommand().parseAsync([], { from: 'user' });

    expect(printed(console.error)).toContain('could not be revoked on the server');
    expect(printed(console.log)).toContain('Logged out successfully');
    expect(process.exitCode).toBeUndefined();
  });

  it('deletes a session file that login did not write', async () => {
    mockSessionManager.readStoredSession.mockResolvedValue({ kind: 'invalid' });
    logout.mockResolvedValue({ revoked: false });

    await createLogoutCommand().parseAsync([], { from: 'user' });

    expect(logout).toHaveBeenCalledTimes(1);
    expect(printed(console.error)).toBe('');
    expect(printed(console.log)).toContain('Logged out successfully');
  });

  it('reports that nobody is logged in without touching anything', async () => {
    mockSessionManager.readStoredSession.mockResolvedValue({ kind: 'none' });

    await createLogoutCommand().parseAsync([], { from: 'user' });

    expect(logout).not.toHaveBeenCalled();
    expect(printed(console.log)).toContain('Not currently logged in');
  });

  it('exits 1 when the local cleanup fails', async () => {
    mockSessionManager.readStoredSession.mockResolvedValue({ kind: 'invalid' });
    logout.mockRejectedValue(new Error('Logout failed: EACCES'));

    await createLogoutCommand().parseAsync([], { from: 'user' });

    expect(process.exitCode).toBe(1);
  });
});
