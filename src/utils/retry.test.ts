/**
 * Tests for retry utility with exponential backoff
 */

import { RateLimitedError, ServerError } from '@protontech/drive-sdk';
import { retryWithBackoff, createRetryConfig, DEFAULT_RETRY_CONFIG, isRetryableError } from './retry';
import { RateLimitError, CaptchaError } from '../errors/types';

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { response: { status, headers: {}, data: {} } });
}

describe('retry utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry transient network errors', async () => {
      const networkError = Object.assign(new Error('Network error'), { code: 'ECONNRESET' });
      const operation = jest
        .fn()
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should retry 5xx server errors', async () => {
      const serverError = httpError(503, 'Service unavailable');
      const operation = jest
        .fn()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry rate-limit errors', async () => {
      const rateLimitError = new RateLimitError('Rate limited', { protonCode: 2028 });
      const operation = jest.fn().mockRejectedValue(rateLimitError);

      await expect(
        retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op')
      ).rejects.toThrow(RateLimitError);

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry CAPTCHA errors', async () => {
      const captchaError = new CaptchaError({
        captchaUrl: 'https://example.com',
        captchaToken: 'token123',
      });
      const operation = jest.fn().mockRejectedValue(captchaError);

      await expect(
        retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op')
      ).rejects.toThrow(CaptchaError);

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry permanent 4xx errors', async () => {
      const clientError = httpError(400, 'Bad request');
      const operation = jest.fn().mockRejectedValue(clientError);

      await expect(
        retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op')
      ).rejects.toBe(clientError);

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry 408 timeout errors', async () => {
      const timeoutError = httpError(408, 'Request timeout');
      const operation = jest
        .fn()
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValue('success');

      const result = await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should respect max attempts', async () => {
      const networkError = Object.assign(new Error('Network error'), { code: 'ETIMEDOUT' });
      const operation = jest.fn().mockRejectedValue(networkError);

      await expect(
        retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op')
      ).rejects.toThrow('Network error');

      expect(operation).toHaveBeenCalledTimes(3); // DEFAULT_RETRY_CONFIG.maxAttempts
    });

    it('should use exponential backoff', async () => {
      const networkError = Object.assign(new Error('Network error'), { code: 'ECONNRESET' });
      const operation = jest.fn().mockRejectedValue(networkError);

      const config = createRetryConfig({ maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2 });
      const startTime = Date.now();

      await expect(
        retryWithBackoff(operation, config, 'test op')
      ).rejects.toThrow('Network error');

      const elapsed = Date.now() - startTime;
      // Should wait: 100ms + 200ms = 300ms minimum
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should respect max delay cap', async () => {
      const networkError = Object.assign(new Error('Network error'), { code: 'ECONNRESET' });
      const operation = jest.fn().mockRejectedValue(networkError);

      const config = createRetryConfig({
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        backoffFactor: 10,
      });

      await expect(
        retryWithBackoff(operation, config, 'test op')
      ).rejects.toThrow('Network error');

      expect(operation).toHaveBeenCalledTimes(5);
    }, 10000); // 10 second timeout (test waits ~7s total)

    it('should retry custom error names in retryableErrors set', async () => {
      const customError = new Error('Custom error');
      customError.name = 'CustomNetworkError';
      const operation = jest.fn()
        .mockRejectedValueOnce(customError)
        .mockResolvedValueOnce('success');

      const config = createRetryConfig({
        retryableErrors: new Set(['CustomNetworkError']),
        initialDelayMs: 10,
      });

      const result = await retryWithBackoff(operation, config, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should retry custom error codes in retryableErrors set', async () => {
      const customError = Object.assign(new Error('Custom code error'), { code: 'CUSTOM_CODE' });
      const operation = jest.fn()
        .mockRejectedValueOnce(customError)
        .mockResolvedValueOnce('success');

      const config = createRetryConfig({
        retryableErrors: new Set(['CUSTOM_CODE']),
        initialDelayMs: 10,
      });

      const result = await retryWithBackoff(operation, config, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should retry ENOTFOUND network errors', async () => {
      const notFoundError = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
      const operation = jest.fn()
        .mockRejectedValueOnce(notFoundError)
        .mockResolvedValueOnce('success');

      const result = await retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry errors not in retryable list', async () => {
      const customError = new Error('UnknownError');
      customError.name = 'UnknownError';
      const operation = jest.fn().mockRejectedValue(customError);

      await expect(
        retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, 'test op')
      ).rejects.toThrow('UnknownError');

      expect(operation).toHaveBeenCalledTimes(1); // No retry
    });
  });

  describe('SDK errors', () => {
    it('retries SDK 5xx server errors and connection failures', async () => {
      const outage = Object.assign(new ServerError('Upstream'), { statusCode: 503 });
      const operation = jest.fn().mockRejectedValueOnce(outage).mockResolvedValue('ok');

      await expect(retryWithBackoff(operation, createRetryConfig({ initialDelayMs: 1 }), 'sdk')).resolves.toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404, 422])('does not retry SDK status %i', async (status) => {
      const error = Object.assign(new ServerError('nope'), { statusCode: status });
      const operation = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(operation, createRetryConfig({ initialDelayMs: 1 }), 'sdk')).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not retry SDK rate limiting', async () => {
      const error = Object.assign(new RateLimitedError('slow down'), { statusCode: 429, code: 85131 });
      expect(isRetryableError(error)).toBe(false);
      const operation = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(operation, createRetryConfig({ initialDelayMs: 1 }), 'sdk')).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('runs the operation once when maxAttempts is 1', async () => {
      const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      const operation = jest.fn().mockRejectedValue(error);

      await expect(retryWithBackoff(operation, createRetryConfig({ maxAttempts: 1 }), 'once')).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('createRetryConfig', () => {
    it('should merge custom config with defaults', () => {
      const config = createRetryConfig({ maxAttempts: 5 });

      expect(config.maxAttempts).toBe(5);
      expect(config.initialDelayMs).toBe(DEFAULT_RETRY_CONFIG.initialDelayMs);
      expect(config.backoffFactor).toBe(DEFAULT_RETRY_CONFIG.backoffFactor);
    });

    it('should merge retryable errors set', () => {
      const config = createRetryConfig({
        retryableErrors: new Set(['CustomError']),
      });

      expect(config.retryableErrors.has('NetworkError')).toBe(true); // from default
      expect(config.retryableErrors.has('CustomError')).toBe(true); // from override
    });
  });
});
