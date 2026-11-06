import {
  AbortError,
  ConnectionError,
  DecryptionError,
  IntegrityError,
  NodeWithSameNameExistsValidationError,
  RateLimitedError,
  ServerError,
  ValidationError,
} from '@protontech/drive-sdk';
import { mapSdkError, toAppError, PROTON_CODE_INSUFFICIENT_SCOPE } from './classify';
import { HttpClientError } from '../api/http-client';
import { AppError, CaptchaError, ErrorCode, RateLimitError, isCaptchaError, isRateLimitError } from './types';
import { ERROR_CODE_STATUS } from '../bridge/protocol';

function serverError(statusCode: number | undefined, code?: number, message = 'server'): ServerError {
  return Object.assign(new ServerError(message), { statusCode, code });
}

describe('toAppError', () => {
  it('returns AppError instances unchanged', () => {
    const error = new AppError('x', ErrorCode.INVALID_PATH, { path: '/x' });
    expect(toAppError(error)).toBe(error);
  });

  it.each([
    [401, undefined, ErrorCode.AUTH_FAILED, false],
    [403, undefined, ErrorCode.PERMISSION_DENIED, false],
    [404, undefined, ErrorCode.NOT_FOUND, false],
    [408, undefined, ErrorCode.TIMEOUT, true],
    [413, undefined, ErrorCode.FILE_TOO_LARGE, false],
    [422, 2000, ErrorCode.VALIDATION_ERROR, false],
    [429, 85131, ErrorCode.RATE_LIMITED, false],
    [500, undefined, ErrorCode.API_ERROR, true],
    [503, undefined, ErrorCode.API_ERROR, true],
    [507, undefined, ErrorCode.QUOTA_EXCEEDED, false],
    [400, 2001, ErrorCode.API_ERROR, false],
  ])('maps SDK ServerError status %s (code %s) to %s', (status, protonCode, expectedCode, recoverable) => {
    const mapped = toAppError(serverError(status, protonCode));
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.isRecoverable).toBe(recoverable);
    expect(mapped.details).toMatchObject({ statusCode: status, sdkError: 'ServerError' });
    if (protonCode !== undefined) expect(mapped.details).toMatchObject({ protonCode });
    expect(ERROR_CODE_STATUS[mapped.code]).toBeDefined();
  });

  it('maps Proton code 9101 to INSUFFICIENT_SCOPE regardless of status', () => {
    expect(toAppError(serverError(403, PROTON_CODE_INSUFFICIENT_SCOPE)).code).toBe(ErrorCode.INSUFFICIENT_SCOPE);
    expect(toAppError(new ValidationError('scope', PROTON_CODE_INSUFFICIENT_SCOPE)).code).toBe(ErrorCode.INSUFFICIENT_SCOPE);
    expect(toAppError(Object.assign(new Error('http'), { response: { status: 400, data: { Code: 9101 } } })).code)
      .toBe(ErrorCode.INSUFFICIENT_SCOPE);
  });

  it('does not treat an OID containing "9101" as a scope failure', () => {
    const mapped = toAppError(new Error('File not found for OID: 9101aa' + 'b'.repeat(58)));
    expect(mapped.code).toBe(ErrorCode.UNKNOWN_ERROR);
  });

  it('maps SDK RateLimitedError to a RateLimitError that the retry policy recognises', () => {
    const mapped = toAppError(Object.assign(new RateLimitedError('slow down'), { statusCode: 429, code: 85131 }));
    expect(mapped).toBeInstanceOf(RateLimitError);
    expect(mapped.code).toBe(ErrorCode.RATE_LIMITED);
    expect(mapped.details).toMatchObject({ statusCode: 429, protonCode: 85131 });
    expect(isRateLimitError(mapped)).toBe(true);
  });

  it('maps the other SDK error classes', () => {
    expect(mapSdkError(new AbortError('stop')).code).toBe(ErrorCode.OPERATION_CANCELLED);
    expect(mapSdkError(new ConnectionError('offline'))).toMatchObject({ code: ErrorCode.NETWORK_ERROR, isRecoverable: true });
    expect(mapSdkError(new DecryptionError('bad key')).code).toBe(ErrorCode.DECRYPTION_FAILED);
    expect(mapSdkError(new IntegrityError('bad signature')).code).toBe(ErrorCode.DECRYPTION_FAILED);
    expect(mapSdkError(new ValidationError('bad name', 2000))).toMatchObject({ code: ErrorCode.VALIDATION_ERROR, details: { protonCode: 2000 } });
    expect(mapSdkError(new NodeWithSameNameExistsValidationError('exists', 2500, 'vol~node')))
      .toMatchObject({ code: ErrorCode.VALIDATION_ERROR, details: { existingNodeUid: 'vol~node' } });
  });

  it('maps HTTP client errors by status and keeps the API payload in details', () => {
    const error = Object.assign(new Error('Request failed with status 401'), {
      name: 'HttpClientError',
      response: { status: 401, headers: {}, data: { Code: 10013, Error: 'Invalid refresh token' } },
    });
    const mapped = toAppError(error);
    expect(mapped.code).toBe(ErrorCode.AUTH_FAILED);
    expect(mapped.details).toMatchObject({ statusCode: 401, protonCode: 10013, apiError: { Code: 10013 } });
  });

  it('reads retry-after for HTTP 429 responses', () => {
    const mapped = toAppError(Object.assign(new Error('429'), {
      response: { status: 429, headers: { 'retry-after': '12' }, data: {} },
    }));
    expect(mapped.code).toBe(ErrorCode.RATE_LIMITED);
    expect(mapped.details).toMatchObject({ retryAfter: 12, statusCode: 429 });
  });

  it('maps HttpClientError without a response to a network failure', () => {
    const error = Object.assign(new Error('socket hang up'), { name: 'HttpClientError', code: 'ECONNRESET' });
    expect(toAppError(error)).toMatchObject({ code: ErrorCode.NETWORK_ERROR, isRecoverable: true });
  });

  it('detects CAPTCHA requirements structurally', () => {
    const mapped = toAppError(Object.assign(new Error('captcha'), {
      response: { status: 422, headers: {}, data: { Code: 9001, Details: { HumanVerificationMethods: ['captcha'] } } },
    }));
    expect(mapped.code).toBe(ErrorCode.CAPTCHA_REQUIRED);
    expect(isCaptchaError(mapped)).toBe(true);
    expect(toAppError(new CaptchaError({ captchaUrl: 'u', captchaToken: 't' }))).toBeInstanceOf(CaptchaError);
  });

  it('maps Node.js system errors and plain values', () => {
    expect(toAppError(Object.assign(new Error('nope'), { code: 'ENOENT', path: '/x' })).code).toBe(ErrorCode.FILE_NOT_FOUND);
    expect(toAppError(Object.assign(new Error('nope'), { code: 'ECONNREFUSED' })).code).toBe(ErrorCode.CONNECTION_REFUSED);
    expect(toAppError(new Error('plain'))).toMatchObject({ code: ErrorCode.UNKNOWN_ERROR, message: 'plain' });
    expect(toAppError('string failure')).toMatchObject({ code: ErrorCode.UNKNOWN_ERROR, message: 'string failure' });
  });
});

describe('HTTP client error details', () => {
  it('stores Retry-After as seconds (error-details.schema.json: number) for any status', () => {
    const error = new HttpClientError('Service unavailable', {
      response: { data: {}, status: 503, headers: { 'retry-after': '120' }, config: { url: '/x', method: 'GET' } as any },
    });
    const appError = toAppError(error);
    expect(appError.details?.retryAfter).toBe(120);
  });

  it('classifies a malformed JSON body as a non-retryable API error', () => {
    const appError = toAppError(new HttpClientError('Invalid JSON', { code: 'EBADJSON' }));
    expect(appError.code).toBe(ErrorCode.API_ERROR);
    expect(appError.isRecoverable).toBe(false);
  });
});
