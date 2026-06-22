import { AuthService } from '../auth';
import { AppError, CaptchaError, ErrorCode } from '../errors/types';
import {
  loginWithBrowserFork,
  loginWithInteractiveChallenges,
  resolveBrowserForkKeyPasswordOptions,
} from './login';

jest.mock('inquirer', () => ({
  prompt: jest.fn(),
}));

jest.mock('ora', () => jest.fn(() => ({
  start: jest.fn().mockReturnThis(),
  stop: jest.fn(),
  succeed: jest.fn(),
})));

jest.mock('../auth/captcha-helper', () => ({
  promptForToken: jest.fn(),
}));

jest.mock('../utils/output', () => ({
  isVerbose: jest.fn(() => false),
  isQuiet: jest.fn(() => false),
  outputResult: jest.fn(),
}));

jest.mock('../utils/open-browser', () => ({
  openBrowserUrl: jest.fn(() => true),
}));

import inquirer from 'inquirer';
import { promptForToken } from '../auth/captcha-helper';
import { outputResult } from '../utils/output';
import { openBrowserUrl } from '../utils/open-browser';

const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
const mockPromptForToken = promptForToken as jest.MockedFunction<typeof promptForToken>;
const mockOutputResult = outputResult as jest.MockedFunction<typeof outputResult>;
const mockOpenBrowserUrl = openBrowserUrl as jest.MockedFunction<typeof openBrowserUrl>;

describe('resolveBrowserForkKeyPasswordOptions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers explicit key-password provider and host', () => {
    expect(resolveBrowserForkKeyPasswordOptions({
      credentialProvider: 'git-credential',
      keyPasswordProvider: ' pass-cli ',
      keyPasswordHost: ' proton-drive-key.example.test ',
    })).toEqual({
      keyPasswordProvider: 'pass-cli',
      keyPasswordHost: 'proton-drive-key.example.test',
    });
  });

  it('falls back to credential-provider for browser-fork key storage', () => {
    expect(resolveBrowserForkKeyPasswordOptions({
      credentialProvider: 'git-credential',
    })).toEqual({
      keyPasswordProvider: 'git-credential',
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
});

describe('loginWithInteractiveChallenges', () => {
  let authService: jest.Mocked<AuthService>;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    authService = {
      login: jest.fn(),
    } as unknown as jest.Mocked<AuthService>;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  });

  it('completes CAPTCHA and TOTP challenges before succeeding', async () => {
    authService.login
      .mockRejectedValueOnce(new CaptchaError({
        captchaUrl: 'https://captcha.example.test',
        captchaToken: 'captcha-challenge',
      }))
      .mockRejectedValueOnce(new AppError(
        'Two-factor authentication code required',
        ErrorCode.TWO_FACTOR_REQUIRED,
        { twoFactorType: 'totp', totpAllowed: true },
        true
      ))
      .mockResolvedValueOnce({} as any);
    mockPromptForToken.mockResolvedValue('captcha-token');
    mockPrompt.mockResolvedValue({ secondFactorCode: '123456' } as any);

    await loginWithInteractiveChallenges(authService, 'user@proton.me', 'password');

    expect(mockPromptForToken).toHaveBeenCalledWith(
      'https://captcha.example.test',
      'captcha-challenge'
    );
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    expect(authService.login).toHaveBeenNthCalledWith(
      1,
      'user@proton.me',
      'password',
      {}
    );
    expect(authService.login).toHaveBeenNthCalledWith(
      2,
      'user@proton.me',
      'password',
      { captchaToken: 'captcha-token' }
    );
    expect(authService.login).toHaveBeenNthCalledWith(
      3,
      'user@proton.me',
      'password',
      { captchaToken: 'captcha-token', secondFactorCode: '123456' }
    );
  });

  it('does not prompt for FIDO2-only accounts', async () => {
    const fidoError = new AppError(
      'FIDO2 two-factor authentication is required',
      ErrorCode.TWO_FACTOR_REQUIRED,
      { twoFactorType: 'fido2', totpAllowed: false },
      true
    );
    authService.login.mockRejectedValue(fidoError);

    await expect(
      loginWithInteractiveChallenges(authService, 'user@proton.me', 'password')
    ).rejects.toBe(fidoError);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(authService.login).toHaveBeenCalledTimes(1);
  });

  it('fails TOTP challenge without prompting in non-interactive mode', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    authService.login.mockRejectedValue(new AppError(
      'Two-factor authentication code required',
      ErrorCode.TWO_FACTOR_REQUIRED,
      { twoFactorType: 'totp', totpAllowed: true },
      true
    ));

    await expect(
      loginWithInteractiveChallenges(authService, 'user@proton.me', 'password')
    ).rejects.toMatchObject({ code: ErrorCode.TWO_FACTOR_REQUIRED });

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(authService.login).toHaveBeenCalledTimes(1);
  });
});

describe('loginWithBrowserFork', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens the browser URL and reports success without printing secrets', async () => {
    const fakeAuthService = {
      login: jest.fn(async ({ onSignInUrl }) => {
        await onSignInUrl('https://account.proton.me/desktop/login?app=drive&pv=3#payload=test');
        return {
          session: { uid: 'uid-123' },
          userKeyPassword: 'derived-user-key-password',
        };
      }),
    } as any;
    const logSpy = jest.spyOn(console, 'log').mockImplementation();

    await loginWithBrowserFork(fakeAuthService);

    const consoleOutput = logSpy.mock.calls.flat().join('\n');
    expect(fakeAuthService.login).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowserUrl).toHaveBeenCalledWith(
      'https://account.proton.me/desktop/login?app=drive&pv=3#payload=test'
    );
    expect(mockOutputResult).toHaveBeenCalledWith('OK');
    expect(consoleOutput).not.toContain('derived-user-key-password');
  });
});
