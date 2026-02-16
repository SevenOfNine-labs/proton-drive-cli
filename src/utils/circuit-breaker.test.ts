/**
 * Tests for circuit breaker pattern
 */

import { CircuitBreaker, CircuitState, CircuitBreakerError } from './circuit-breaker';

// Mock logger
jest.mock('./logger');

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;
  let successOperation: jest.Mock;
  let failureOperation: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    breaker = new CircuitBreaker('test-circuit', {
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      halfOpenMaxAttempts: 2,
    });
    successOperation = jest.fn().mockResolvedValue('success');
    failureOperation = jest.fn().mockRejectedValue(new Error('operation failed'));
  });

  describe('closed state', () => {
    it('should allow operations through when closed', async () => {
      const result = await breaker.execute(successOperation);

      expect(result).toBe('success');
      expect(successOperation).toHaveBeenCalledTimes(1);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should track failures but stay closed under threshold', async () => {
      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      expect(breaker.getFailureCount()).toBe(1);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      expect(breaker.getFailureCount()).toBe(2);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should open circuit after reaching failure threshold', async () => {
      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');

      expect(breaker.getState()).toBe(CircuitState.OPEN);
      expect(breaker.getFailureCount()).toBe(3);
    });

    it('should reset failure count after success', async () => {
      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      expect(breaker.getFailureCount()).toBe(1);

      await breaker.execute(successOperation);
      expect(breaker.getFailureCount()).toBe(0);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('open state', () => {
    beforeEach(async () => {
      // Trip the circuit
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reject operations immediately when open', async () => {
      await expect(breaker.execute(successOperation)).rejects.toThrow(CircuitBreakerError);
      await expect(breaker.execute(successOperation)).rejects.toThrow('Circuit breaker is OPEN');

      // Operation should not have been called
      expect(successOperation).not.toHaveBeenCalled();
    });

    it('should transition to half-open after reset timeout', async () => {
      // Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Next operation should transition to half-open
      const result = await breaker.execute(successOperation);
      expect(result).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should include failure count in error', async () => {
      try {
        await breaker.execute(successOperation);
        fail('Should have thrown CircuitBreakerError');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitBreakerError);
        expect((error as CircuitBreakerError).circuitState).toBe(CircuitState.OPEN);
        expect((error as CircuitBreakerError).failures).toBe(3);
      }
    });
  });

  describe('half-open state', () => {
    beforeEach(async () => {
      // Trip the circuit
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();

      // Wait for reset timeout and transition to half-open
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    it('should close circuit after 2 successes in half-open', async () => {
      await breaker.execute(successOperation);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      await breaker.execute(successOperation);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('should reopen circuit on failure in half-open', async () => {
      await breaker.execute(successOperation);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      await expect(breaker.execute(failureOperation)).rejects.toThrow('operation failed');
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should limit attempts in half-open state', async () => {
      // First attempt succeeds
      await breaker.execute(successOperation);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Second attempt (still testing)
      await breaker.execute(successOperation);
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow multiple successful attempts in half-open before closing', async () => {
      // This test verifies that the circuit requires 2 successes to close from half-open
      const result1 = await breaker.execute(successOperation);
      expect(result1).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      const result2 = await breaker.execute(successOperation);
      expect(result2).toBe('success');
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reopen circuit if half-open max attempts exceeded', async () => {
      // Create a custom breaker with halfOpenMaxAttempts: 1
      const customBreaker = new CircuitBreaker('test-limit', {
        failureThreshold: 2,
        resetTimeoutMs: 500,
        halfOpenMaxAttempts: 1,
      });

      // Trip the circuit
      const failOp = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(customBreaker.execute(failOp)).rejects.toThrow();
      await expect(customBreaker.execute(failOp)).rejects.toThrow();
      expect(customBreaker.getState()).toBe(CircuitState.OPEN);

      // Wait for reset timeout and transition to half-open
      await new Promise((resolve) => setTimeout(resolve, 600));

      // First attempt in half-open succeeds
      const succeedOp = jest.fn().mockResolvedValue('ok');
      await customBreaker.execute(succeedOp);
      expect(customBreaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Second attempt exceeds halfOpenMaxAttempts (1), should reopen with "Recovery test failed"
      try {
        await customBreaker.execute(succeedOp);
        fail('Should have thrown CircuitBreakerError');
      } catch (error) {
        expect(error).toBeInstanceOf(CircuitBreakerError);
        expect((error as Error).message).toContain('Recovery test failed');
      }
      expect(customBreaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('reset', () => {
    it('should manually reset circuit to closed', async () => {
      // Trip the circuit
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Manual reset
      breaker.reset();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getFailureCount()).toBe(0);

      // Should allow operations again
      const result = await breaker.execute(successOperation);
      expect(result).toBe('success');
    });
  });

  describe('isOpen', () => {
    it('should return true when circuit is open', async () => {
      expect(breaker.isOpen()).toBe(false);

      // Trip the circuit
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();

      expect(breaker.isOpen()).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return circuit breaker statistics', async () => {
      await expect(breaker.execute(failureOperation)).rejects.toThrow();
      await expect(breaker.execute(failureOperation)).rejects.toThrow();

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failureCount).toBe(2);
      expect(stats.successCount).toBe(0);
      expect(stats.lastFailureTime).toBeGreaterThan(0);
    });
  });
});
