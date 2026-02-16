/**
 * Tests for error types and detection functions
 */

import {
  RateLimitError,
  CaptchaError,
  AppError,
  isRateLimitError,
  isCaptchaError,
  ErrorCode,
  ErrorCategory,
  categorizeError,
} from './types';

describe('error types', () => {
  describe('RateLimitError', () => {
    it('should create rate-limit error with metadata', () => {
      const error = new RateLimitError('Rate limited', {
        retryAfter: 60,
        protonCode: 2028,
      });

      expect(error.name).toBe('RateLimitError');
      expect(error.message).toBe('Rate limited');
      expect(error.code).toBe(ErrorCode.RATE_LIMITED);
      expect(error.retryAfter).toBe(60);
      expect(error.protonCode).toBe(2028);
      expect(error.isRecoverable).toBe(false);
    });

    it('should work without optional metadata', () => {
      const error = new RateLimitError('Rate limited');

      expect(error.retryAfter).toBeUndefined();
      expect(error.protonCode).toBeUndefined();
    });
  });

  describe('CaptchaError', () => {
    it('should create CAPTCHA error with metadata', () => {
      const error = new CaptchaError({
        captchaUrl: 'https://example.com/captcha',
        captchaToken: 'token123',
        verificationMethods: ['captcha', 'sms'],
      });

      expect(error.name).toBe('CaptchaError');
      expect(error.code).toBe(ErrorCode.CAPTCHA_REQUIRED);
      expect(error.captchaUrl).toBe('https://example.com/captcha');
      expect(error.captchaToken).toBe('token123');
      expect(error.verificationMethods).toEqual(['captcha', 'sms']);
      expect(error.isRecoverable).toBe(true);
    });
  });

  describe('isRateLimitError', () => {
    it('should detect RateLimitError instances', () => {
      const error = new RateLimitError('Rate limited');
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect HTTP 429 status', () => {
      const error = {
        response: { status: 429 },
        message: 'Too many requests',
      };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect Proton code 2028', () => {
      const error = {
        response: { data: { Code: 2028 } },
        message: 'Rate limited',
      };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should detect Proton code 85131', () => {
      const error = {
        response: { data: { Code: 85131 } },
        message: 'Anti-abuse',
      };
      expect(isRateLimitError(error)).toBe(true);
    });

    it('should return false for non-rate-limit errors', () => {
      const error = new Error('Generic error');
      expect(isRateLimitError(error)).toBe(false);
    });

    it('should return false for 4xx errors that are not 429', () => {
      const error = {
        response: { status: 400 },
        message: 'Bad request',
      };
      expect(isRateLimitError(error)).toBe(false);
    });
  });

  describe('isCaptchaError', () => {
    it('should detect CaptchaError instances', () => {
      const error = new CaptchaError({
        captchaUrl: 'https://example.com',
        captchaToken: 'token',
      });
      expect(isCaptchaError(error)).toBe(true);
    });

    it('should detect Proton code 9001', () => {
      const error = {
        response: { data: { Code: 9001 } },
        message: 'CAPTCHA required',
      };
      expect(isCaptchaError(error)).toBe(true);
    });

    it('should detect Proton code 12087', () => {
      const error = {
        response: { data: { Code: 12087 } },
        message: 'CAPTCHA token invalid',
      };
      expect(isCaptchaError(error)).toBe(true);
    });

    it('should detect HumanVerificationToken in Details', () => {
      const error = {
        response: {
          data: {
            Code: 2028,
            Details: { HumanVerificationToken: 'token123' },
          },
        },
        message: 'Verification required',
      };
      expect(isCaptchaError(error)).toBe(true);
    });

    it('should return false for non-CAPTCHA errors', () => {
      const error = new Error('Generic error');
      expect(isCaptchaError(error)).toBe(false);
    });

    it('should return false for rate-limit errors', () => {
      const error = {
        response: { data: { Code: 2028 } },
        message: 'Rate limited',
      };
      expect(isCaptchaError(error)).toBe(false);
    });
  });

  describe('categorizeError', () => {
    it('should categorize rate-limit errors', () => {
      const error = new RateLimitError('Rate limited', {
        retryAfter: 60,
        protonCode: 2028,
      });

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.RATE_LIMIT);
      expect(categorized.retryable).toBe(false);
      expect(categorized.userMessage).toContain('Rate limit');
      expect(categorized.protonCode).toBe(2028);
    });

    it('should categorize CAPTCHA errors', () => {
      const error = new CaptchaError({
        captchaUrl: 'https://example.com/captcha',
        captchaToken: 'token123',
      });

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.CAPTCHA);
      expect(categorized.retryable).toBe(false);
      expect(categorized.userMessage).toContain('CAPTCHA');
      expect(categorized.recoverySuggestion).toContain('proton-drive login');
    });

    it('should categorize 401 as auth error', () => {
      const error = {
        response: { status: 401, data: { Code: 1000 } },
        message: 'Unauthorized',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.AUTH);
      expect(categorized.retryable).toBe(false);
      expect(categorized.httpStatus).toBe(401);
      expect(categorized.recoverySuggestion).toContain('proton-drive login');
    });

    it('should categorize 404 as not found', () => {
      const error = {
        response: { status: 404 },
        message: 'Not found',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.NOT_FOUND);
      expect(categorized.retryable).toBe(false);
      expect(categorized.httpStatus).toBe(404);
    });

    it('should categorize 5xx as server error (retryable)', () => {
      const error = {
        response: { status: 503 },
        message: 'Service unavailable',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.SERVER);
      expect(categorized.retryable).toBe(true);
      expect(categorized.httpStatus).toBe(503);
    });

    it('should categorize 4xx as client error (not retryable)', () => {
      const error = {
        response: { status: 400 },
        message: 'Bad request',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.CLIENT);
      expect(categorized.retryable).toBe(false);
      expect(categorized.httpStatus).toBe(400);
    });

    it('should categorize network errors as retryable', () => {
      const error = {
        code: 'ECONNRESET',
        message: 'Connection reset',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.NETWORK);
      expect(categorized.retryable).toBe(true);
      expect(categorized.recoverySuggestion).toContain('internet connection');
    });

    it('should categorize ETIMEDOUT as network error', () => {
      const error = {
        code: 'ETIMEDOUT',
        message: 'Timeout',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.NETWORK);
      expect(categorized.retryable).toBe(true);
    });

    it('should categorize unknown errors', () => {
      const error = new Error('Something went wrong');

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.UNKNOWN);
      expect(categorized.retryable).toBe(false);
      expect(categorized.message).toBe('Something went wrong');
    });

    it('should include protonCode when available', () => {
      const error = {
        response: { status: 500, data: { Code: 12345 } },
        message: 'Server error',
      };

      const categorized = categorizeError(error);

      expect(categorized.protonCode).toBe(12345);
    });

    it('should categorize permission denied (403 with permission keyword)', () => {
      const error = {
        response: { status: 403 },
        message: 'Permission denied for this resource',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.PERMISSION);
      expect(categorized.retryable).toBe(false);
      expect(categorized.userMessage).toContain('Permission denied');
    });

    it('should treat 403 without permission keyword as auth error', () => {
      const error = {
        response: { status: 403 },
        message: 'Forbidden',
      };

      const categorized = categorizeError(error);

      expect(categorized.category).toBe(ErrorCategory.AUTH);
      expect(categorized.retryable).toBe(false);
    });
  });

  describe('AppError.toUserMessage', () => {
    it('should return user-friendly message for AUTH_FAILED', () => {
      const error = new AppError('Auth failed', ErrorCode.AUTH_FAILED);
      expect(error.toUserMessage()).toContain('Authentication failed');
    });

    it('should return user-friendly message for SESSION_EXPIRED', () => {
      const error = new AppError('Expired', ErrorCode.SESSION_EXPIRED);
      expect(error.toUserMessage()).toContain('session has expired');
    });

    it('should return user-friendly message for NETWORK_ERROR', () => {
      const error = new AppError('Network failed', ErrorCode.NETWORK_ERROR);
      expect(error.toUserMessage()).toContain('Network connection failed');
    });

    it('should return user-friendly message for TIMEOUT', () => {
      const error = new AppError('Timed out', ErrorCode.TIMEOUT);
      expect(error.toUserMessage()).toContain('timed out');
    });

    it('should return user-friendly message for FILE_NOT_FOUND with path', () => {
      const error = new AppError('Not found', ErrorCode.FILE_NOT_FOUND, { path: '/test/file.txt' });
      expect(error.toUserMessage()).toContain('/test/file.txt');
    });

    it('should return user-friendly message for FILE_TOO_LARGE with maxSize', () => {
      const error = new AppError('Too large', ErrorCode.FILE_TOO_LARGE, { maxSize: '5GB' });
      expect(error.toUserMessage()).toContain('5GB');
    });

    it('should return user-friendly message for PERMISSION_DENIED with path', () => {
      const error = new AppError('Denied', ErrorCode.PERMISSION_DENIED, { path: '/secure/file' });
      expect(error.toUserMessage()).toContain('Permission denied');
      expect(error.toUserMessage()).toContain('/secure/file');
    });

    it('should return user-friendly message for DISK_FULL', () => {
      const error = new AppError('No space', ErrorCode.DISK_FULL);
      expect(error.toUserMessage()).toContain('No space left');
    });

    it('should return user-friendly message for RATE_LIMITED', () => {
      const error = new AppError('', ErrorCode.RATE_LIMITED);
      expect(error.toUserMessage()).toContain('Too many requests');
    });

    it('should return user-friendly message for QUOTA_EXCEEDED', () => {
      const error = new AppError('Quota exceeded', ErrorCode.QUOTA_EXCEEDED);
      expect(error.toUserMessage()).toContain('Storage quota exceeded');
    });

    it('should return user-friendly message for CAPTCHA_REQUIRED', () => {
      const error = new AppError('CAPTCHA', ErrorCode.CAPTCHA_REQUIRED);
      expect(error.toUserMessage()).toContain('CAPTCHA verification required');
    });

    it('should return user-friendly message for ENCRYPTION_FAILED', () => {
      const error = new AppError('Encryption failed', ErrorCode.ENCRYPTION_FAILED);
      expect(error.toUserMessage()).toContain('Encryption failed');
    });

    it('should return user-friendly message for DECRYPTION_FAILED', () => {
      const error = new AppError('Decryption failed', ErrorCode.DECRYPTION_FAILED);
      expect(error.toUserMessage()).toContain('Decryption failed');
    });

    it('should return default message for unknown error codes', () => {
      const error = new AppError('Custom error', 'UNKNOWN_CODE' as ErrorCode);
      expect(error.toUserMessage()).toBe('Custom error');
    });
  });

  describe('AppError.getRecoverySuggestion', () => {
    it('should return recovery suggestion for AUTH_FAILED', () => {
      const error = new AppError('Auth failed', ErrorCode.AUTH_FAILED);
      expect(error.getRecoverySuggestion()).toContain('proton-drive login');
    });

    it('should return recovery suggestion for SESSION_EXPIRED', () => {
      const error = new AppError('Expired', ErrorCode.SESSION_EXPIRED);
      expect(error.getRecoverySuggestion()).toContain('proton-drive login');
    });

    it('should return recovery suggestion for NETWORK_ERROR', () => {
      const error = new AppError('Network failed', ErrorCode.NETWORK_ERROR);
      expect(error.getRecoverySuggestion()).toContain('internet connection');
    });

    it('should return recovery suggestion for RATE_LIMITED', () => {
      const error = new AppError('Rate limited', ErrorCode.RATE_LIMITED);
      expect(error.getRecoverySuggestion()).toContain('Wait a few moments');
    });

    it('should return recovery suggestion for QUOTA_EXCEEDED', () => {
      const error = new AppError('Quota exceeded', ErrorCode.QUOTA_EXCEEDED);
      expect(error.getRecoverySuggestion()).toContain('Free up space');
    });

    it('should return recovery suggestion for FILE_NOT_FOUND', () => {
      const error = new AppError('Not found', ErrorCode.FILE_NOT_FOUND);
      expect(error.getRecoverySuggestion()).toContain('file path is correct');
    });

    it('should return recovery suggestion for PERMISSION_DENIED', () => {
      const error = new AppError('Denied', ErrorCode.PERMISSION_DENIED);
      expect(error.getRecoverySuggestion()).toContain('permissions');
    });

    it('should return recovery suggestion for DISK_FULL', () => {
      const error = new AppError('No space', ErrorCode.DISK_FULL);
      expect(error.getRecoverySuggestion()).toContain('Free up disk space');
    });

    it('should return recovery suggestion for CAPTCHA_REQUIRED', () => {
      const error = new AppError('CAPTCHA', ErrorCode.CAPTCHA_REQUIRED);
      expect(error.getRecoverySuggestion()).toContain('proton-drive login');
    });

    it('should return null for errors without recovery suggestions', () => {
      const error = new AppError('Upload failed', ErrorCode.UPLOAD_FAILED);
      expect(error.getRecoverySuggestion()).toBeNull();
    });
  });
});
