/**
 * Tests for change token caching
 */

// @ts-nocheck - Mock typing issues with fs-extra overloads
import { ChangeTokenCache } from './change-tokens';
import * as fs from 'fs-extra';
import * as path from 'path';

// Mock fs-extra
jest.mock('fs-extra');

// Mock logger
jest.mock('../utils/logger');

describe('ChangeTokenCache', () => {
  let tempDir: string;
  let cache: ChangeTokenCache;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = '/tmp/test-cache';
    cache = new ChangeTokenCache(tempDir);
  });

  describe('load and save', () => {
    it('should load cache from disk', async () => {
      const cacheData = {
        'abc123': {
          oid: 'abc123',
          mtime: 1234567890,
          size: 1024,
          uploadedAt: Date.now(),
        },
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(JSON.stringify(cacheData) as any);

      await cache.load();

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join(tempDir, 'change-tokens.json'),
        'utf-8'
      );
    });

    it('should handle missing cache file gracefully', async () => {
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock error value
      mockRejectedValue(error);

      await cache.load();

      // Should not throw
      expect(fs.readFile).toHaveBeenCalled();
    });

    it('should save cache to disk atomically', async () => {
      jest.spyOn(fs, 'ensureDir').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'writeFile').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'move').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);

      await cache.save();

      expect(fs.ensureDir).toHaveBeenCalledWith(tempDir);
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.any(String)
      );
      expect(fs.move).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        path.join(tempDir, 'change-tokens.json'),
        { overwrite: true }
      );
    });

    it('should be idempotent on multiple load() calls', async () => {
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue('{}' as any);

      await cache.load();
      await cache.load();
      await cache.load();

      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('shouldUpload', () => {
    it('should require upload if no cache entry exists', async () => {
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock error value
      mockRejectedValue({ code: 'ENOENT' } as any);
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock return value
      mockResolvedValue({
        mtimeMs: 1234567890,
        size: 1024,
      } as any);

      const result = await cache.shouldUpload('abc123', '/path/to/file');

      expect(result).toBe(true);
    });

    it('should skip upload if mtime and size match', async () => {
      const cacheData = {
        'abc123': {
          oid: 'abc123',
          mtime: 1234567890,
          size: 1024,
          uploadedAt: Date.now(),
        },
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(JSON.stringify(cacheData) as any);
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock return value
      mockResolvedValue({
        mtimeMs: 1234567890,
        size: 1024,
      } as any);

      const result = await cache.shouldUpload('abc123', '/path/to/file');

      expect(result).toBe(false);
    });

    it('should require upload if mtime changed', async () => {
      const cacheData = {
        'abc123': {
          oid: 'abc123',
          mtime: 1234567890,
          size: 1024,
          uploadedAt: Date.now(),
        },
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(JSON.stringify(cacheData) as any);
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock return value
      mockResolvedValue({
        mtimeMs: 9999999999, // Changed
        size: 1024,
      } as any);

      const result = await cache.shouldUpload('abc123', '/path/to/file');

      expect(result).toBe(true);
    });

    it('should require upload if size changed', async () => {
      const cacheData = {
        'abc123': {
          oid: 'abc123',
          mtime: 1234567890,
          size: 1024,
          uploadedAt: Date.now(),
        },
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(JSON.stringify(cacheData) as any);
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock return value
      mockResolvedValue({
        mtimeMs: 1234567890,
        size: 2048, // Changed
      } as any);

      const result = await cache.shouldUpload('abc123', '/path/to/file');

      expect(result).toBe(true);
    });

    it('should require upload if file does not exist', async () => {
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue('{}' as any);
      const error: any = new Error('File not found');
      error.code = 'ENOENT';
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock error value
      mockRejectedValue(error);

      const result = await cache.shouldUpload('abc123', '/path/to/missing');

      expect(result).toBe(true);
    });

    it('should handle non-ENOENT stat errors gracefully', async () => {
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue('{}' as any);
      const permError: any = new Error('Permission denied');
      permError.code = 'EACCES';
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock error value
      mockRejectedValue(permError);

      // Should require upload when stat fails for other reasons
      const result = await cache.shouldUpload('abc123', '/path/to/file');

      expect(result).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle corrupted cache file during load', async () => {
      const corruptedError: any = new Error('Invalid JSON');
      corruptedError.code = 'EINVAL';
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock error value
      mockRejectedValue(corruptedError);

      // Should not throw, just initialize empty cache
      await expect(cache.load()).resolves.not.toThrow();
      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(0);
    });

    it('should handle save failures gracefully', async () => {
      jest.spyOn(fs, 'ensureDir').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      const writeError = new Error('Disk full');
      jest.spyOn(fs, 'writeFile').// @ts-expect-error Mock error value
      mockRejectedValue(writeError);

      // Should not throw, just log warning
      await expect(cache.save()).resolves.not.toThrow();
    });
  });

  describe('recordUpload', () => {
    it('should record upload with mtime and size', async () => {
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock return value
      mockResolvedValue({
        mtimeMs: 1234567890,
        size: 1024,
      } as any);

      await cache.recordUpload('abc123', '/path/to/file');

      // Verify by attempting to save
      jest.spyOn(fs, 'ensureDir').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'writeFile').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'move').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);

      await cache.save();

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"abc123"')
      );
    });

    it('should handle stat errors gracefully', async () => {
      jest.spyOn(fs, 'stat').// @ts-expect-error Mock error value
      mockRejectedValue(new Error('Stat failed'));

      await cache.recordUpload('abc123', '/path/to/file');

      // Should not throw
    });
  });

  describe('prune', () => {
    it('should remove entries older than maxAge', async () => {
      const now = Date.now();
      const oldEntry = {
        oid: 'old123',
        mtime: 1234567890,
        size: 1024,
        uploadedAt: now - (31 * 24 * 60 * 60 * 1000), // 31 days ago
      };
      const recentEntry = {
        oid: 'recent456',
        mtime: 1234567890,
        size: 2048,
        uploadedAt: now - (10 * 24 * 60 * 60 * 1000), // 10 days ago
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(
        JSON.stringify({
          old123: oldEntry,
          recent456: recentEntry,
        }) as any
      );
      jest.spyOn(fs, 'ensureDir').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'writeFile').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'move').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);

      const pruned = await cache.prune(30 * 24 * 60 * 60 * 1000); // 30 days

      expect(pruned).toBe(1);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should not save if nothing was pruned', async () => {
      const now = Date.now();
      const recentEntry = {
        oid: 'recent456',
        mtime: 1234567890,
        size: 2048,
        uploadedAt: now - (10 * 24 * 60 * 60 * 1000), // 10 days ago
      };

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(
        JSON.stringify({
          recent456: recentEntry,
        }) as any
      );

      const pruned = await cache.prune(30 * 24 * 60 * 60 * 1000); // 30 days

      expect(pruned).toBe(0);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should clear all entries', async () => {
      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(
        JSON.stringify({
          abc123: { oid: 'abc123', mtime: 1, size: 1, uploadedAt: 1 },
          def456: { oid: 'def456', mtime: 2, size: 2, uploadedAt: 2 },
        }) as any
      );
      jest.spyOn(fs, 'ensureDir').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'writeFile').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);
      jest.spyOn(fs, 'move').// @ts-expect-error Mock return value
      mockResolvedValue(undefined as any);

      await cache.load();
      await cache.clear();

      const stats = cache.getStats();
      expect(stats.totalEntries).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const now = Date.now();
      const oldTime = now - 1000000;
      const newTime = now - 100000;

      jest.spyOn(fs, 'readFile').// @ts-expect-error Mock return value
      mockResolvedValue(
        JSON.stringify({
          old123: {
            oid: 'old123',
            mtime: 1,
            size: 1,
            uploadedAt: oldTime,
          },
          new456: {
            oid: 'new456',
            mtime: 2,
            size: 2,
            uploadedAt: newTime,
          },
        }) as any
      );

      await cache.load();
      const stats = cache.getStats();

      expect(stats.totalEntries).toBe(2);
      expect(stats.oldestUpload).toBe(oldTime);
      expect(stats.newestUpload).toBe(newTime);
    });

    it('should handle empty cache', () => {
      const stats = cache.getStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.oldestUpload).toBeNull();
      expect(stats.newestUpload).toBeNull();
    });
  });
});
