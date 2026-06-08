import { AuthService } from '../auth';
import { AppError, CaptchaError, ErrorCode } from '../errors/types';
import { loginWithInteractiveChallenges } from './login';

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

import inquirer from 'inquirer';
import { promptForToken } from '../auth/captcha-helper';

const mockPrompt = inquirer.prompt as jest.MockedFunction<typeof inquirer.prompt>;
const mockPromptForToken = promptForToken as jest.MockedFunction<typeof promptForToken>;

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
