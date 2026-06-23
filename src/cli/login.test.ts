import {
  createLoginCommand,
  loginWithBrowserFork,
  resolveBrowserForkKeyPasswordOptions,
} from './login';

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

import { outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';

const mockOutputResult = outputResult as jest.MockedFunction<typeof outputResult>;
const mockOpenBrowserUrl = openBrowserUrl as jest.MockedFunction<typeof openBrowserUrl>;

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
