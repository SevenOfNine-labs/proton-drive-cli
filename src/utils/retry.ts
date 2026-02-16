/**
 * Retry utilities with exponential backoff for transient failures
 */

import { isRateLimitError, isCaptchaError } from '../errors/types';
import { logger } from './logger';

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (including initial attempt) */
  maxAttempts: number;
  /** Initial delay in milliseconds before first retry */
  initialDelayMs: number;
  /** Maximum delay in milliseconds (cap for exponential backoff) */
  maxDelayMs: number;
  /** Backoff multiplier (delay multiplied by this each retry) */
  backoffFactor: number;
  /** Set of error names that should be retried */
  retryableErrors: Set<string>;
}

/**
 * Default retry configuration
 * - 3 attempts total (1 initial + 2 retries)
 * - Start with 1s delay, max 10s, 2x backoff
 * - Retry network and timeout errors
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
  retryableErrors: new Set(['NetworkError', 'TimeoutError', 'ECONNABORTED']),
};

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a permanent error that should never be retried
 * @param error - Error to check
 * @returns True if error is permanent (4xx client errors except 408/429)
 */
function isPermanentError(error: any): boolean {
  const status = error?.response?.status;
  // 4xx errors are permanent except:
  // - 408 Request Timeout (transient)
  // - 429 Too Many Requests (handled separately as rate-limit)
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true;
  }
  return false;
}

/**
 * Check if an error should be retried based on configuration
 * @param error - Error to check
 * @param config - Retry configuration
 * @returns True if error is retryable
 */
function isRetryableError(error: any, config: RetryConfig): boolean {
  // Network errors (connection reset, timeout, not found)
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  // 5xx server errors are retryable
  const status = error?.response?.status;
  if (status >= 500 && status < 600) {
    return true;
  }

  // 408 Request Timeout is retryable
  if (status === 408) {
    return true;
  }

  // Check custom retryable error list
  if (config.retryableErrors.has(error.name)) {
    return true;
  }

  // Check error code (e.g., ECONNABORTED)
  if (error.code && config.retryableErrors.has(error.code)) {
    return true;
  }

  return false;
}

/**
 * Execute an async operation with automatic retry on transient failures.
 *
 * NEVER retries:
 * - Rate-limit errors (code 2028, 85131, HTTP 429)
 * - CAPTCHA errors (code 9001, 12087)
 * - Permanent errors (4xx client errors except 408)
 *
 * DOES retry:
 * - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND)
 * - Server errors (5xx)
 * - Timeout errors (408, ECONNABORTED)
 * - Custom retryable errors in config
 *
 * @param operation - Async function to execute
 * @param config - Retry configuration (uses DEFAULT_RETRY_CONFIG if not provided)
 * @param context - Human-readable context for logging (e.g., "Upload file abc.txt")
 * @returns Promise resolving to operation result
 * @throws Last error if all retry attempts fail
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = 'Operation'
): Promise<T> {
  let lastError: Error | undefined;
  let delayMs = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // NEVER retry rate-limit errors — fail fast
      if (isRateLimitError(error)) {
        logger.debug(`${context} failed with rate-limit error, not retrying`);
        throw error;
      }

      // NEVER retry CAPTCHA errors — user action required
      if (isCaptchaError(error)) {
        logger.debug(`${context} failed with CAPTCHA error, not retrying`);
        throw error;
      }

      // NEVER retry permanent errors (4xx client errors)
      if (isPermanentError(error)) {
        logger.debug(`${context} failed with permanent error (${(error as any)?.response?.status}), not retrying`);
        throw error;
      }

      // Check if error is retryable
      if (!isRetryableError(error, config)) {
        logger.debug(`${context} failed with non-retryable error, not retrying`);
        throw error;
      }

      // If this was the last attempt, throw
      if (attempt === config.maxAttempts) {
        logger.warn(`${context} failed after ${config.maxAttempts} attempts`);
        break;
      }

      // Log retry attempt
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorCode = (error as any)?.code || (error as any)?.response?.status || 'unknown';
      logger.warn(`${context} failed (attempt ${attempt}/${config.maxAttempts}, error: ${errorCode}), retrying in ${delayMs}ms...`);

      // Sleep before retry
      await sleep(delayMs);

      // Exponential backoff with cap
      delayMs = Math.min(delayMs * config.backoffFactor, config.maxDelayMs);
    }
  }

  // All attempts failed
  throw lastError;
}

/**
 * Create a custom retry configuration
 * @param overrides - Partial configuration to override defaults
 * @returns Complete retry configuration
 */
export function createRetryConfig(overrides: Partial<RetryConfig>): RetryConfig {
  return {
    ...DEFAULT_RETRY_CONFIG,
    ...overrides,
    // Merge retryableErrors sets if provided
    retryableErrors: overrides.retryableErrors
      ? new Set([...DEFAULT_RETRY_CONFIG.retryableErrors, ...overrides.retryableErrors])
      : DEFAULT_RETRY_CONFIG.retryableErrors,
  };
}
