/**
 * Tests for timeout configuration
 */

import {
  loadTimeoutConfig,
  getTimeoutConfig,
  resetTimeoutConfig,
  createTimeoutSignal,
  withTimeout,
  DEFAULT_TIMEOUTS,
} from './timeouts';

describe('Timeout Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    resetTimeoutConfig();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadTimeoutConfig', () => {
    it('should return default values when no env vars set', () => {
      const config = loadTimeoutConfig();

      expect(config.authMs).toBe(DEFAULT_TIMEOUTS.authMs);
      expect(config.uploadMs).toBe(DEFAULT_TIMEOUTS.uploadMs);
      expect(config.downloadMs).toBe(DEFAULT_TIMEOUTS.downloadMs);
      expect(config.listMs).toBe(DEFAULT_TIMEOUTS.listMs);
      expect(config.apiMs).toBe(DEFAULT_TIMEOUTS.apiMs);
    });

    it('should load timeout from environment variable', () => {
      process.env.PROTON_DRIVE_AUTH_TIMEOUT_MS = '60000';

      const config = loadTimeoutConfig();

      expect(config.authMs).toBe(60000);
      expect(config.uploadMs).toBe(DEFAULT_TIMEOUTS.uploadMs);
    });

    it('should load multiple timeouts from environment', () => {
      process.env.PROTON_DRIVE_AUTH_TIMEOUT_MS = '45000';
      process.env.PROTON_DRIVE_UPLOAD_TIMEOUT_MS = '600000';

      const config = loadTimeoutConfig();

      expect(config.authMs).toBe(45000);
      expect(config.uploadMs).toBe(600000);
    });

    it('should use default for invalid timeout values', () => {
      process.env.PROTON_DRIVE_AUTH_TIMEOUT_MS = 'invalid';

      const config = loadTimeoutConfig();

      expect(config.authMs).toBe(DEFAULT_TIMEOUTS.authMs);
    });

    it('should use default for negative timeout values', () => {
      process.env.PROTON_DRIVE_AUTH_TIMEOUT_MS = '-1000';

      const config = loadTimeoutConfig();

      expect(config.authMs).toBe(DEFAULT_TIMEOUTS.authMs);
    });

    it('should cap timeout at maximum (10 minutes)', () => {
      process.env.PROTON_DRIVE_UPLOAD_TIMEOUT_MS = '999999999';

      const config = loadTimeoutConfig();

      expect(config.uploadMs).toBe(10 * 60 * 1000); // 10 minutes
    });
  });

  describe('getTimeoutConfig', () => {
    it('should return the same config instance on multiple calls', () => {
      const config1 = getTimeoutConfig();
      const config2 = getTimeoutConfig();

      expect(config1).toBe(config2);
    });

    it('should reload config after reset', () => {
      const config1 = getTimeoutConfig();
      resetTimeoutConfig();

      process.env.PROTON_DRIVE_AUTH_TIMEOUT_MS = '90000';
      const config2 = getTimeoutConfig();

      expect(config2.authMs).toBe(90000);
      expect(config1).not.toBe(config2);
    });
  });

  describe('createTimeoutSignal', () => {
    it('should create an AbortSignal that aborts after timeout', async () => {
      const signal = createTimeoutSignal(100);

      expect(signal.aborted).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(signal.aborted).toBe(true);
    });
  });

  describe('withTimeout', () => {
    it('should return operation result if completes within timeout', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const result = await withTimeout(operation, 1000, 'Test operation');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalled();
    });

    it('should reject if operation exceeds timeout', async () => {
      const operation = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('too slow'), 500))
      );

      await expect(withTimeout(operation, 100, 'Slow operation')).rejects.toThrow(
        'Slow operation timed out after 100ms'
      );
    });

    it('should propagate operation errors', async () => {
      const operation = jest.fn().mockRejectedValue(new Error('Operation failed'));

      await expect(withTimeout(operation, 1000, 'Failing operation')).rejects.toThrow('Operation failed');
    });

    it('should use default operation name if not provided', async () => {
      const operation = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve('done'), 500))
      );

      await expect(withTimeout(operation, 100)).rejects.toThrow('Operation timed out after 100ms');
    });
  });
});
