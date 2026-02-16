/**
 * Circuit breaker pattern implementation for protecting against cascading failures
 *
 * States:
 * - CLOSED: Normal operation, requests flow through
 * - OPEN: Failing state, requests rejected immediately
 * - HALF_OPEN: Testing recovery, allow limited requests through
 */

import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreakerOptions {
  failureThreshold: number;      // Number of failures before opening
  resetTimeoutMs: number;         // Time to wait before testing recovery
  halfOpenMaxAttempts: number;    // Number of attempts allowed in half-open state
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly circuitState: CircuitState,
    public readonly failures: number
  ) {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

/**
 * Circuit breaker for protecting against cascading failures
 *
 * Automatically opens after repeated failures, preventing further requests
 * until a recovery timeout elapses. Then enters half-open state to test recovery.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private halfOpenAttempts: number = 0;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions = {
      failureThreshold: 5,
      resetTimeoutMs: 60000, // 1 minute
      halfOpenMaxAttempts: 3,
    }
  ) {}

  /**
   * Execute an operation through the circuit breaker
   * @param operation - Async operation to execute
   * @returns Result of the operation
   * @throws CircuitBreakerError if circuit is open
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    // Check if circuit should transition to half-open
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime > this.options.resetTimeoutMs) {
        logger.info(`[CircuitBreaker:${this.name}] Transitioning to HALF_OPEN (testing recovery)`);
        this.state = CircuitState.HALF_OPEN;
        this.halfOpenAttempts = 0;
        this.successCount = 0;
      } else {
        throw new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.name}. Requests rejected.`,
          this.state,
          this.failureCount
        );
      }
    }

    // In half-open state, limit attempts
    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.options.halfOpenMaxAttempts) {
        logger.warn(`[CircuitBreaker:${this.name}] Half-open max attempts reached, reopening circuit`);
        this.state = CircuitState.OPEN;
        this.lastFailureTime = Date.now();
        throw new CircuitBreakerError(
          `Circuit breaker is OPEN for ${this.name}. Recovery test failed.`,
          this.state,
          this.failureCount
        );
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      // Require at least 2 successes before closing
      if (this.successCount >= 2) {
        logger.info(`[CircuitBreaker:${this.name}] Transitioning to CLOSED (recovered)`);
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
        this.successCount = 0;
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success
      if (this.failureCount > 0) {
        logger.debug(`[CircuitBreaker:${this.name}] Success after ${this.failureCount} failures, resetting`);
        this.failureCount = 0;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      logger.warn(`[CircuitBreaker:${this.name}] Failure in HALF_OPEN state, reopening circuit`);
      this.state = CircuitState.OPEN;
      this.halfOpenAttempts = 0;
      this.successCount = 0;
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= this.options.failureThreshold) {
        logger.error(
          `[CircuitBreaker:${this.name}] Failure threshold reached (${this.failureCount}/${this.options.failureThreshold}), opening circuit`
        );
        this.state = CircuitState.OPEN;
      } else {
        logger.warn(
          `[CircuitBreaker:${this.name}] Failure ${this.failureCount}/${this.options.failureThreshold}`
        );
      }
    }
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get current failure count
   */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    logger.info(`[CircuitBreaker:${this.name}] Manually reset to CLOSED`);
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Check if circuit is allowing requests
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}
