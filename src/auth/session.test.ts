/**
 * Tests for session management with proactive refresh, validation, and file locking
 */

// @ts-nocheck - Mock typing issues with fs-extra overloads
import { SessionManager } from './session';
import { SessionCredentials } from '../types/auth';
import * as fs from 'fs-extra';
import * as path from 'path';
import { homedir } from 'os';

// Mock fs-extra
jest.mock('fs-extra');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock dependencies
jest.mock('../api/auth');
jest.mock('../api/user');
jest.mock('../utils/logger');

describe('SessionManager', () => {
  const mockSession: SessionCredentials = {
    sessionId: 'session123',
    uid: 'uid123',
    accessToken: 'access_token',
    refreshToken: 'refresh_token',
    scopes: ['full'],
    passwordMode: 1,
    tokenExpiresAt: Date.now() + (60 * 60 * 1000), // 1 hour from now
    userHash: 'hash123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('proactive token refresh', () => {
    it('should not refresh if token is not expiring soon', async () => {
      const session = {
        ...mockSession,
        tokenExpiresAt: Date.now() + (60 * 60 * 1000), // 1 hour from now
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(session);

      const result = await SessionManager.getValidSession();

      expect(result).toEqual(session);
      // Should not attempt refresh
    });

    it('should proactively refresh if token expires within 5 minutes', async () => {
      const expiringSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() + (4 * 60 * 1000), // 4 minutes from now
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(expiringSession);

      const { AuthApiClient } = await import('../api/auth');
      const mockAuthApi = AuthApiClient as jest.MockedClass<typeof AuthApiClient>;
      mockAuthApi.prototype.refreshToken = jest.fn().mockResolvedValue({
        AccessToken: 'new_access_token',
        RefreshToken: 'new_refresh_token',
        ExpiresIn: 3600,
      });

      mockFs.ensureDir.mockResolvedValue(undefined);
      mockFs.writeJson.mockResolvedValue(undefined);
      mockFs.move.mockResolvedValue(undefined);

      const result = await SessionManager.getValidSession();

      expect(result?.accessToken).toBe('new_access_token');
      expect(mockAuthApi.prototype.refreshToken).toHaveBeenCalled();
    });

    it('should fallback to current session if proactive refresh fails', async () => {
      const expiringSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() + (4 * 60 * 1000), // 4 minutes from now
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(expiringSession);

      const { AuthApiClient } = await import('../api/auth');
      const mockAuthApi = AuthApiClient as jest.MockedClass<typeof AuthApiClient>;
      mockAuthApi.prototype.refreshToken = jest.fn().mockRejectedValue(new Error('Network error'));

      const result = await SessionManager.getValidSession();

      // Should return the current session despite refresh failure
      expect(result).toEqual(expiringSession);
    });
  });

  describe('session validation', () => {
    it('should validate session locally if not expired', async () => {
      const validSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() + (60 * 60 * 1000), // 1 hour from now
      };

      const isValid = await SessionManager.validateSession(validSession, false);

      expect(isValid).toBe(true);
    });

    it('should detect expired session locally', async () => {
      const expiredSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() - 1000, // Expired 1 second ago
      };

      const isValid = await SessionManager.validateSession(expiredSession, false);

      expect(isValid).toBe(false);
    });

    it('should validate session remotely with API call', async () => {
      const validSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() + (60 * 60 * 1000),
      };

      const { UserApiClient } = await import('../api/user');
      const mockUserApi = UserApiClient as jest.MockedClass<typeof UserApiClient>;
      mockUserApi.prototype.getUser = jest.fn().mockResolvedValue({ ID: 'user123' });

      const isValid = await SessionManager.validateSession(validSession, true);

      expect(isValid).toBe(true);
      expect(mockUserApi.prototype.getUser).toHaveBeenCalled();
    });

    it('should detect invalid session remotely with 401', async () => {
      const session = { ...mockSession };

      const { UserApiClient } = await import('../api/user');
      const mockUserApi = UserApiClient as jest.MockedClass<typeof UserApiClient>;
      mockUserApi.prototype.getUser = jest.fn().mockRejectedValue({
        response: { status: 401 },
      });

      const isValid = await SessionManager.validateSession(session, true);

      expect(isValid).toBe(false);
    });

    it('should assume valid on network errors during remote validation', async () => {
      const session = { ...mockSession };

      const { UserApiClient } = await import('../api/user');
      const mockUserApi = UserApiClient as jest.MockedClass<typeof UserApiClient>;
      mockUserApi.prototype.getUser = jest.fn().mockRejectedValue(new Error('Network error'));

      const isValid = await SessionManager.validateSession(session, true);

      expect(isValid).toBe(true); // Network error, assume valid
    });
  });

  describe('session reuse (getOrCreateSession)', () => {
    it('should reuse existing valid session', async () => {
      const validSession = {
        ...mockSession,
        userHash: SessionManager.hashUsername('user@example.com'),
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(validSession);

      const { UserApiClient } = await import('../api/user');
      const mockUserApi = UserApiClient as jest.MockedClass<typeof UserApiClient>;
      mockUserApi.prototype.getUser = jest.fn().mockResolvedValue({ ID: 'user123' });

      const result = await SessionManager.getOrCreateSession(
        'user@example.com',
        'password123',
        true
      );

      expect(result).toEqual(validSession);
      // Should not perform SRP auth
    });

    it('should create new session if no session exists', async () => {
      mockFs.pathExists.mockResolvedValue(false);

      const { AuthService } = await import('./index');
      const mockAuthService = AuthService as jest.MockedClass<typeof AuthService>;
      mockAuthService.prototype.login = jest.fn().mockResolvedValue(mockSession);

      const result = await SessionManager.getOrCreateSession(
        'user@example.com',
        'password123'
      );

      expect(mockAuthService.prototype.login).toHaveBeenCalledWith(
        'user@example.com',
        'password123'
      );
    });

    it('should create new session if user changed', async () => {
      const existingSession = {
        ...mockSession,
        userHash: SessionManager.hashUsername('old@example.com'),
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(existingSession);

      const { AuthService } = await import('./index');
      const mockAuthService = AuthService as jest.MockedClass<typeof AuthService>;
      mockAuthService.prototype.login = jest.fn().mockResolvedValue(mockSession);

      const result = await SessionManager.getOrCreateSession(
        'new@example.com',
        'password123'
      );

      expect(mockAuthService.prototype.login).toHaveBeenCalled();
    });

    it('should create new session if validation fails', async () => {
      const invalidSession = {
        ...mockSession,
        tokenExpiresAt: Date.now() - 1000, // Expired
        userHash: SessionManager.hashUsername('user@example.com'),
      };
      mockFs.pathExists.mockResolvedValue(true);
      mockFs.readJson.mockResolvedValue(invalidSession);

      const { AuthService } = await import('./index');
      const mockAuthService = AuthService as jest.MockedClass<typeof AuthService>;
      mockAuthService.prototype.login = jest.fn().mockResolvedValue(mockSession);

      const result = await SessionManager.getOrCreateSession(
        'user@example.com',
        'password123'
      );

      expect(mockAuthService.prototype.login).toHaveBeenCalled();
    });
  });

  describe('file locking', () => {
    it('should acquire and release lock successfully', async () => {
      mockFs.writeFile.mockResolvedValue(undefined); // Lock acquired
      mockFs.remove.mockResolvedValue(undefined); // Lock released
      mockFs.ensureDir.mockResolvedValue(undefined);
      mockFs.writeJson.mockResolvedValue(undefined);
      mockFs.move.mockResolvedValue(undefined);

      await SessionManager.saveSession(mockSession);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.lock'),
        expect.any(String),
        expect.objectContaining({ flag: 'wx' })
      );
      expect(mockFs.remove).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });

    it('should detect and remove stale lock from dead process', async () => {
      // First write fails (lock exists)
      mockFs.writeFile.mockRejectedValueOnce({ code: 'EEXIST' });
      // Read stale PID
      mockFs.readFile.mockResolvedValueOnce('99999');
      // process.kill will throw (process not found)
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('ESRCH');
      });
      // Remove stale lock
      mockFs.remove.mockResolvedValueOnce(undefined);
      // Second write succeeds
      mockFs.writeFile.mockResolvedValueOnce(undefined);
      mockFs.ensureDir.mockResolvedValue(undefined);
      mockFs.writeJson.mockResolvedValue(undefined);
      mockFs.move.mockResolvedValue(undefined);
      mockFs.remove.mockResolvedValueOnce(undefined); // Final lock removal

      await SessionManager.saveSession(mockSession);

      expect(mockFs.remove).toHaveBeenCalledWith(expect.stringContaining('.lock'));
    });
  });

  describe('username hashing', () => {
    it('should hash username consistently', () => {
      const hash1 = SessionManager.hashUsername('user@example.com');
      const hash2 = SessionManager.hashUsername('user@example.com');
      expect(hash1).toBe(hash2);
    });

    it('should be case-insensitive', () => {
      const hash1 = SessionManager.hashUsername('User@Example.com');
      const hash2 = SessionManager.hashUsername('user@example.com');
      expect(hash1).toBe(hash2);
    });

    it('should trim whitespace', () => {
      const hash1 = SessionManager.hashUsername('  user@example.com  ');
      const hash2 = SessionManager.hashUsername('user@example.com');
      expect(hash1).toBe(hash2);
    });
  });
});
