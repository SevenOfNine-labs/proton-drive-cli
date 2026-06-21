import { handleError } from './handler';
import { AppError, ErrorCode } from './types';
import { REDACTED_VALUE } from '../utils/redaction';

describe('handleError', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('redacts sensitive nested details in debug output', () => {
    handleError(
      new AppError('API request failed', ErrorCode.API_ERROR, {
        apiError: {
          Code: 9001,
          AccessToken: 'access-token',
          Details: {
            WebUrl: 'https://verify.proton.me',
            HumanVerificationToken: 'hvt-token',
          },
        },
        Authorization: 'Bearer bearer-token',
        password: 'login-password',
      }),
      true
    );

    const output = errorSpy.mock.calls.flat().join('\n');

    expect(output).toContain(REDACTED_VALUE);
    expect(output).toContain('https://verify.proton.me');
    expect(output).not.toContain('access-token');
    expect(output).not.toContain('hvt-token');
    expect(output).not.toContain('bearer-token');
    expect(output).not.toContain('login-password');
  });
});
