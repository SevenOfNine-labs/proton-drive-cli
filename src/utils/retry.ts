/** Retry with exponential backoff (p-retry, https://github.com/sindresorhus/p-retry) under the project's policy. */

import pRetry from 'p-retry';
import { ErrorCode, isCaptchaError, isRateLimitError } from '../errors/types';
import { toAppError } from '../errors/classify';
import { logger } from './logger';

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of attempts (including the initial attempt) */
  maxAttempts: number;
  /** Initial delay in milliseconds before the first retry */
  initialDelayMs: number;
  /** Maximum delay in milliseconds (cap for exponential backoff) */
  maxDelayMs: number;
  /** Backoff multiplier (delay multiplied by this each retry) */
  backoffFactor: number;
  /** Error names or codes that are retried in addition to the policy above */
  retryableErrors: Set<string>;
}

/**
 * Default retry configuration
 * - 3 attempts total (1 initial + 2 retries)
 * - Start with 1s delay, max 10s, 2x backoff
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffFactor: 2,
  retryableErrors: new Set(['NetworkError', 'TimeoutError', 'ECONNABORTED']),
};

const RETRYABLE_ERROR_CODES = new Set<ErrorCode>([
  ErrorCode.NETWORK_ERROR,
  ErrorCode.TIMEOUT,
  ErrorCode.CONNECTION_REFUSED,
]);

/**
 * Decide whether a failed attempt may be retried, from the classification the
 * bridge reports to the Go adapter (errors/classify).
 *
 * Never retried: rate limits (Proton codes 2028/85131, HTTP 429), CAPTCHA
 * (Proton codes 9001/12087) and permanent failures (4xx except 408, auth,
 * validation). Retried: network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, SDK
 * ConnectionError), server errors (5xx), request timeouts (408, ECONNABORTED)
 * and the error names or codes in `retryableErrors`.
 */
export function isRetryableError(error: unknown, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  if (isRateLimitError(error) || isCaptchaError(error)) {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown } | null | undefined;
  if (typeof candidate?.name === 'string' && config.retryableErrors.has(candidate.name)) {
    return true;
  }
  if (typeof candidate?.code === 'string' && config.retryableErrors.has(candidate.code)) {
    return true;
  }

  const appError = toAppError(error);
  if (RETRYABLE_ERROR_CODES.has(appError.code)) {
    return true;
  }
  // API_ERROR is recoverable only for 5xx responses (errors/classify).
  return appError.code === ErrorCode.API_ERROR && appError.isRecoverable;
}

function describeError(error: unknown): string {
  const candidate = error as { code?: unknown; response?: { status?: unknown }; statusCode?: unknown } | null;
  return String(candidate?.code ?? candidate?.response?.status ?? candidate?.statusCode ?? 'unknown');
}

/**
 * Execute an async operation with automatic retry on transient failures.
 *
 * @param operation - Async function to execute
 * @param config - Retry configuration (DEFAULT_RETRY_CONFIG if not provided)
 * @param context - Human-readable context for logging (e.g., "Upload file abc.txt")
 * @returns Promise resolving to the operation result
 * @throws The last error when the operation is not retryable or attempts are exhausted
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  context: string = 'Operation'
): Promise<T> {
  return pRetry(() => operation(), {
    retries: config.maxAttempts - 1,
    factor: config.backoffFactor,
    minTimeout: config.initialDelayMs,
    maxTimeout: config.maxDelayMs,
    randomize: false,
    onFailedAttempt: ({ retriesLeft }) => {
      if (retriesLeft === 0 && config.maxAttempts > 1) {
        logger.warn(`${context} failed after ${config.maxAttempts} attempts`);
      }
    },
    shouldRetry: ({ error, attemptNumber, retryDelay }) => {
      if (!isRetryableError(error, config)) {
        logger.debug(`${context} failed with non-retryable error, not retrying`);
        return false;
      }
      logger.warn(
        `${context} failed (attempt ${attemptNumber}/${config.maxAttempts}, error: ${describeError(error)}), retrying in ${retryDelay}ms...`
      );
      return true;
    },
  });
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
    retryableErrors: overrides.retryableErrors
      ? new Set([...DEFAULT_RETRY_CONFIG.retryableErrors, ...overrides.retryableErrors])
      : DEFAULT_RETRY_CONFIG.retryableErrors,
  };
}
