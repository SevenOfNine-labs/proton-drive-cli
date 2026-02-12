import { validateOid, validateLocalPath, errorToStatusCode, formatCaptchaError } from './bridge';
import { BridgeRequest } from '../bridge/validators';
import { ErrorCode, CaptchaError } from '../errors/types';

describe('validateOid', () => {
  const VALID_OID = '4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393';

  it('accepts valid 64-char hex OID', () => {
    expect(() => validateOid(VALID_OID)).not.toThrow();
  });

  it('accepts uppercase hex OID', () => {
    expect(() => validateOid(VALID_OID.toUpperCase())).not.toThrow();
  });

  it('rejects 63-char OID', () => {
    expect(() => validateOid(VALID_OID.slice(0, 63))).toThrow('Invalid OID format');
  });

  it('rejects 65-char OID', () => {
    expect(() => validateOid(VALID_OID + 'a')).toThrow('Invalid OID format');
  });

  it('rejects non-hex characters', () => {
    const nonHex = 'g'.repeat(64);
    expect(() => validateOid(nonHex)).toThrow('Invalid OID format');
  });

  it('rejects empty string', () => {
    expect(() => validateOid('')).toThrow('OID is required');
  });

  it('rejects null/undefined', () => {
    expect(() => validateOid(null as any)).toThrow('OID is required');
    expect(() => validateOid(undefined as any)).toThrow('OID is required');
  });
});

describe('validateLocalPath', () => {
  it('accepts a valid absolute path', () => {
    expect(() => validateLocalPath('/tmp/file.txt')).not.toThrow();
  });

  it('accepts a valid relative path', () => {
    expect(() => validateLocalPath('file.txt')).not.toThrow();
  });

  it('rejects path with .. traversal', () => {
    expect(() => validateLocalPath('../etc/passwd')).toThrow('Path traversal not allowed');
  });

  it('rejects absolute path with .. traversal', () => {
    expect(() => validateLocalPath('/tmp/../etc/passwd')).toThrow('Path traversal not allowed');
  });

  it('rejects empty string', () => {
    expect(() => validateLocalPath('')).toThrow('File path is required');
  });

  it('rejects null/undefined', () => {
    expect(() => validateLocalPath(null as any)).toThrow('File path is required');
    expect(() => validateLocalPath(undefined as any)).toThrow('File path is required');
  });
});

describe('errorToStatusCode', () => {
  it('maps AUTH_FAILED to 401', () => {
    expect(errorToStatusCode({ code: ErrorCode.AUTH_FAILED })).toBe(401);
  });

  it('maps SESSION_EXPIRED to 401', () => {
    expect(errorToStatusCode({ code: ErrorCode.SESSION_EXPIRED })).toBe(401);
  });

  it('maps NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.NOT_FOUND })).toBe(404);
  });

  it('maps PATH_NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.PATH_NOT_FOUND })).toBe(404);
  });

  it('maps FILE_NOT_FOUND to 404', () => {
    expect(errorToStatusCode({ code: ErrorCode.FILE_NOT_FOUND })).toBe(404);
  });

  it('maps FILE_TOO_LARGE to 413', () => {
    expect(errorToStatusCode({ code: ErrorCode.FILE_TOO_LARGE })).toBe(413);
  });

  it('maps RATE_LIMITED to 429', () => {
    expect(errorToStatusCode({ code: ErrorCode.RATE_LIMITED })).toBe(429);
  });

  it('maps TIMEOUT to 504', () => {
    expect(errorToStatusCode({ code: ErrorCode.TIMEOUT })).toBe(504);
  });

  it('maps OPERATION_CANCELLED to 499', () => {
    expect(errorToStatusCode({ code: ErrorCode.OPERATION_CANCELLED })).toBe(499);
  });

  it('falls back to 500 for unknown error codes', () => {
    expect(errorToStatusCode({ code: 'SOMETHING_WEIRD' })).toBe(500);
  });

  it('falls back to message-based matching for "not found"', () => {
    expect(errorToStatusCode({ message: 'Resource not found' })).toBe(404);
  });

  it('falls back to message-based matching for "unauthorized"', () => {
    expect(errorToStatusCode({ message: 'Unauthorized request' })).toBe(401);
  });

  it('falls back to message-based matching for "invalid"', () => {
    expect(errorToStatusCode({ message: 'Invalid input provided' })).toBe(400);
  });

  it('maps CAPTCHA_REQUIRED to 407', () => {
    expect(errorToStatusCode({ code: ErrorCode.CAPTCHA_REQUIRED })).toBe(407);
  });

  it('falls back to message-based matching for "captcha"', () => {
    expect(errorToStatusCode({ message: 'CAPTCHA verification required' })).toBe(407);
  });

  it('returns 500 for null/undefined error', () => {
    expect(errorToStatusCode(null)).toBe(500);
    expect(errorToStatusCode(undefined)).toBe(500);
  });
});

describe('BridgeRequest credentialProvider field', () => {
  it('accepts credentialProvider in the request type', () => {
    const request: BridgeRequest = {
      credentialProvider: 'git-credential',
    };
    expect(request.credentialProvider).toBe('git-credential');
  });

  it('is optional (backward compatible)', () => {
    const request: BridgeRequest = {
      username: 'user@proton.me',
      password: 'secret',
    };
    expect(request.credentialProvider).toBeUndefined();
  });

  it('can coexist with username/password', () => {
    const request: BridgeRequest = {
      username: 'user@proton.me',
      password: 'secret',
      credentialProvider: 'git-credential',
    };
    expect(request.username).toBe('user@proton.me');
    expect(request.credentialProvider).toBe('git-credential');
  });
});

describe('formatCaptchaError', () => {
  it('produces 407 response with captchaUrl in details', () => {
    const err = new CaptchaError({
      captchaUrl: 'https://verify.proton.me/captcha?token=abc',
      captchaToken: 'hvt-abc123',
      verificationMethods: ['captcha'],
    });
    const resp = formatCaptchaError(err);
    expect(resp.ok).toBe(false);
    expect(resp.code).toBe(407);
    expect(resp.error).toContain('CAPTCHA verification required');
    const details = JSON.parse(resp.details!);
    expect(details.captchaUrl).toContain('verify.proton.me');
    expect(details.captchaToken).toBe('hvt-abc123');
    expect(details.verificationMethods).toEqual(['captcha']);
    expect(details.action).toBe('run: proton-drive login');
  });

  it('handles empty verificationMethods', () => {
    const err = new CaptchaError({
      captchaUrl: 'https://verify.proton.me/captcha',
      captchaToken: 'hvt-xyz',
    });
    const resp = formatCaptchaError(err);
    expect(resp.code).toBe(407);
    const details = JSON.parse(resp.details!);
    expect(details.verificationMethods).toEqual([]);
  });
});
