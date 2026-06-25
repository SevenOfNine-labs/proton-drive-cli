import {
  createLoginCommand,
  createSessionRefreshCommand,
  loginWithBrowserFork,
  resolveBrowserForkKeyPasswordOptions,
} from './login';
import { SessionManager } from '../auth/session';
import { HttpClientError } from '../api/http-client';

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
    refreshSession: jest.fn(),
  },
}));

import { outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';

const mockOutputResult = outputResult as jest.MockedFunction<typeof outputResult>;
const mockOpenBrowserUrl = openBrowserUrl as jest.MockedFunction<typeof openBrowserUrl>;
const mockSessionManager = SessionManager as jest.Mocked<typeof SessionManager>;

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

  it('keeps legacy PROTON_CREDENTIAL_PROVIDER only as key-password fallback', () => {
    process.env.PROTON_CREDENTIAL_PROVIDER = 'git-credential';

    expect(resolveBrowserForkKeyPasswordOptions()).toEqual({
      keyPasswordProvider: 'git-credential',
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
  });

  it('emits JSON success without token values', async () => {
    mockSessionManager.loadSession.mockResolvedValue({
      sessionId: 'session-id',
      uid: 'uid-123',
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      scopes: ['drive'],
      passwordMode: 1,
    });
    mockSessionManager.refreshSession.mockResolvedValue({
      sessionId: 'session-id',
      uid: 'uid-123',
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      scopes: ['drive'],
      passwordMode: 1,
      tokenExpiresAt: 1893456000000,
    });

    await createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' });

    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    expect(output).toContain('"ok":true');
    expect(output).toContain('"refreshed":true');
    for (const secret of ['old-access-token', 'old-refresh-token', 'new-access-token', 'new-refresh-token', 'uid-123']) {
      expect(output).not.toContain(secret);
    }
  });

  it('emits JSON terminal failure with redacted API details', async () => {
    mockSessionManager.loadSession.mockResolvedValue({
      sessionId: 'session-id',
      uid: 'uid-123',
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      scopes: ['drive'],
      passwordMode: 1,
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

    await expect(createSessionRefreshCommand().parseAsync(['refresh', '--json'], { from: 'user' }))
      .rejects.toThrow('process.exit:1');

    const output = (console.log as jest.Mock).mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: false,
      state: 'refresh_failed',
      errorCode: 'API_ERROR',
      recoverable: false,
      statusCode: 400,
      protonCode: 10013,
      protonError: 'Invalid refresh token',
    });
    expect(parsed.action).toContain('stop:');
    expect(output).not.toContain('raw-refresh-token');
    expect(output).not.toContain('uid-123');
  });
});
