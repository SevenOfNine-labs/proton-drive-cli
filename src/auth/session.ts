import * as fs from 'fs-extra';
import * as path from 'path';
import { homedir } from 'os';
import { createHash, randomBytes } from 'crypto';
import { jwtDecode } from 'jwt-decode';
import { SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';

/**
 * Session manager for storing and retrieving authentication credentials
 * Stores session data in ~/.proton-drive-cli/session.json
 *
 * Also manages a crypto-init cache (crypto-cache.json) that stores the
 * raw API responses for keySalts, user, and addresses. These are encrypted
 * (armored PGP keys) and safe to persist — the password is required at
 * runtime to decrypt them. This eliminates 3 API round-trips per subprocess.
 */

const SESSION_DIR = path.join(homedir(), '.proton-drive-cli');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');
const SESSION_LOCK_FILE = path.join(SESSION_DIR, 'session.json.lock');
const CRYPTO_CACHE_FILE = path.join(SESSION_DIR, 'crypto-cache.json');

export interface CryptoCache {
  sessionUid: string;
  keySalts: Array<{ ID: string; KeySalt: string | null }>;
  user: any;
  addresses: any[];
  cachedAt: string;
}

export class SessionManager {
  // Proactively refresh tokens when within 5 minutes of expiry
  private static readonly REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  // Lock acquisition timeout (prevents deadlocks)
  private static readonly LOCK_TIMEOUT_MS = 5000; // 5 seconds
  // Lock poll interval
  private static readonly LOCK_POLL_INTERVAL_MS = 100; // 100ms

  /**
   * Acquire a file lock for session operations.
   * Uses a .lock file with timeout to prevent deadlocks.
   * Retries with exponential backoff until timeout.
   *
   * @param fn - Function to execute while holding the lock
   * @returns Result of the function
   * @throws Error if lock cannot be acquired within timeout
   */
  private static async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const maxWaitMs = this.LOCK_TIMEOUT_MS;
    const pollIntervalMs = this.LOCK_POLL_INTERVAL_MS;
    let waited = 0;
    let lockAcquired = false;

    // Try to acquire lock
    while (waited < maxWaitMs) {
      try {
        // Create lock file exclusively (fails if exists)
        await fs.writeFile(SESSION_LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
        lockAcquired = true;
        break;
      } catch (error: any) {
        if (error.code === 'EEXIST') {
          // Lock file exists — check if it's stale (process no longer exists)
          try {
            const lockPid = parseInt(await fs.readFile(SESSION_LOCK_FILE, 'utf-8'), 10);
            if (lockPid && !isNaN(lockPid)) {
              try {
                // Check if process exists (throws if not)
                process.kill(lockPid, 0);
                // Process exists — wait and retry
              } catch {
                // Process doesn't exist — remove stale lock
                logger.debug(`Removing stale lock file (PID ${lockPid} not found)`);
                await fs.remove(SESSION_LOCK_FILE).catch(() => {});
                continue; // Retry immediately
              }
            }
          } catch {
            // Can't read lock file — try to remove it
            await fs.remove(SESSION_LOCK_FILE).catch(() => {});
            continue;
          }

          // Lock is held by another process — wait
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          waited += pollIntervalMs;
          continue;
        }
        // Other error (e.g., permission denied)
        throw error;
      }
    }

    if (!lockAcquired) {
      throw new Error('Failed to acquire session file lock within timeout');
    }

    // Execute function with lock held
    try {
      return await fn();
    } finally {
      // Always release lock
      try {
        await fs.remove(SESSION_LOCK_FILE);
      } catch (error) {
        logger.warn('Failed to remove lock file:', error);
      }
    }
  }

  /**
   * Save session credentials to disk with file locking.
   * @param session - Session credentials to save
   */
  static async saveSession(session: SessionCredentials): Promise<void> {
    try {
      // Ensure directory exists with owner-only permissions
      await fs.ensureDir(SESSION_DIR, { mode: 0o700 });

      // Strip mailboxPassword — passwords are never persisted to disk.
      // The password flows via stdin on every bridge invocation (from pass-cli).
      const { mailboxPassword, ...safeSession } = session as SessionCredentials & { mailboxPassword?: string };

      // Use file lock to prevent concurrent writes
      await this.withFileLock(async () => {
        // Write atomically: unique temp file with restrictive mode, then rename.
        const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
        const tmpFile = `${SESSION_FILE}.tmp-${suffix}`;
        try {
          await fs.writeJson(tmpFile, safeSession, { spaces: 2, mode: 0o600 });
          await fs.move(tmpFile, SESSION_FILE, { overwrite: true });
        } catch (writeErr) {
          // Clean up temp file on error to avoid leaking session data
          await fs.remove(tmpFile).catch(() => {});
          throw writeErr;
        }
      });
    } catch (error) {
      throw new Error(`Failed to save session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load session credentials from disk
   * @returns Session credentials or null if not found
   */
  static async loadSession(): Promise<SessionCredentials | null> {
    try {
      if (await fs.pathExists(SESSION_FILE)) {
        const session = await fs.readJson(SESSION_FILE);

        // Validate session has required fields
        if (this.isValidSession(session)) {
          return session;
        } else {
          logger.warn('Session file is corrupted or invalid. Please login again.');
          return null;
        }
      }
    } catch (error) {
      logger.error('Failed to load session:', error instanceof Error ? error.message : 'Unknown error');
    }
    return null;
  }

  /**
   * Clear saved session from disk
   */
  static async clearSession(): Promise<void> {
    try {
      if (await fs.pathExists(SESSION_FILE)) {
        await fs.remove(SESSION_FILE);
      }
    } catch (error) {
      throw new Error(`Failed to clear session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if a valid session exists
   * @returns True if a valid session exists
   */
  static async hasValidSession(): Promise<boolean> {
    const session = await this.loadSession();
    if (!session) return false;

    if (!this.isValidSession(session)) return false;

    // Check if access token is expired
    try {
      const decoded = jwtDecode<{ exp?: number }>(session.accessToken);
      if (decoded.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (decoded.exp <= now) {
          logger.debug('Session access token has expired');
          return false;
        }
      }
    } catch {
      // If token can't be decoded, treat session as valid (non-JWT tokens)
    }

    return true;
  }

  /**
   * Validate session object has all required fields
   * @param session - Session object to validate
   * @returns True if session is valid
   */
  private static isValidSession(session: any): session is SessionCredentials {
    return !!(
      session &&
      typeof session === 'object' &&
      session.sessionId &&
      session.uid &&
      session.accessToken &&
      session.refreshToken &&
      Array.isArray(session.scopes) &&
      typeof session.passwordMode === 'number'
    );
  }

  /**
   * Hash a username for session identity comparison.
   * Uses SHA-256 of the lowercased, trimmed username.
   */
  static hashUsername(username: string): string {
    return createHash('sha256').update(username.toLowerCase().trim()).digest('hex');
  }

  /**
   * Check if the current session belongs to a specific user.
   * Returns true if a valid session exists AND its userHash matches.
   * Returns false if no session exists, session is invalid, or hash doesn't match.
   * Legacy sessions without userHash are treated as matching (backward compat).
   */
  static async isSessionForUser(username: string): Promise<boolean> {
    if (!await this.hasValidSession()) return false;
    const session = await this.loadSession();
    if (!session) return false;

    // Legacy sessions without userHash — assume they match
    if (!session.userHash) return true;

    return session.userHash === this.hashUsername(username);
  }

  /**
   * Get session directory path
   * @returns Path to session directory
   */
  static getSessionDir(): string {
    return SESSION_DIR;
  }

  /**
   * Get session file path
   * @returns Path to session file
   */
  static getSessionFilePath(): string {
    return SESSION_FILE;
  }

  /**
   * Check if a session token is expiring soon (within REFRESH_THRESHOLD_MS).
   * @param session - Session to check
   * @returns True if token expires within the threshold
   */
  private static isExpiringSoon(session: SessionCredentials): boolean {
    if (!session.tokenExpiresAt) return false;
    const now = Date.now();
    const timeUntilExpiry = session.tokenExpiresAt - now;
    return timeUntilExpiry < this.REFRESH_THRESHOLD_MS && timeUntilExpiry > 0;
  }

  /**
   * Refresh session tokens using the refresh token.
   * Updates the session file with new tokens and expiration time.
   * @param session - Current session to refresh
   * @returns Updated session with new tokens
   */
  private static async refreshSessionTokens(session: SessionCredentials): Promise<SessionCredentials> {
    // Import AuthApiClient here to avoid circular dependencies
    const { AuthApiClient } = await import('../api/auth');
    const authApi = new AuthApiClient();

    logger.debug(`Refreshing tokens for session ${session.uid}`);
    const result = await authApi.refreshToken(session.uid, session.refreshToken);

    const updatedSession: SessionCredentials = {
      ...session,
      accessToken: result.AccessToken,
      refreshToken: result.RefreshToken,
      tokenExpiresAt: result.ExpiresIn ? Date.now() + (result.ExpiresIn * 1000) : undefined,
    };

    await this.saveSession(updatedSession);
    logger.info('Token refreshed successfully (proactive)');
    return updatedSession;
  }

  /**
   * Get a valid session, proactively refreshing tokens if they are expiring soon.
   * This method should be called before operations to ensure the token is valid
   * for the duration of the operation (preventing mid-operation expiration).
   *
   * @returns Valid session or null if no session exists
   */
  static async getValidSession(): Promise<SessionCredentials | null> {
    const session = await this.loadSession();
    if (!session) return null;

    // Check if token is expiring soon and proactively refresh
    if (this.isExpiringSoon(session)) {
      logger.info('Token expiring soon, proactively refreshing...');
      try {
        return await this.refreshSessionTokens(session);
      } catch (error) {
        logger.warn('Proactive refresh failed, token may expire during operation:', error);
        // Continue with current session — will retry on 401
        // The operation may still succeed if the token hasn't expired yet
        return session;
      }
    }

    // Token is not expiring soon, return as-is
    return session;
  }

  /**
   * Validate a session by checking token expiration and optionally making a lightweight API call.
   * @param session - Session to validate
   * @param remoteCheck - If true, makes an API call to verify the session is valid on the server
   * @returns True if session is valid
   */
  static async validateSession(session: SessionCredentials, remoteCheck: boolean = false): Promise<boolean> {
    // Quick local validation: check if token is expired
    if (session.tokenExpiresAt && Date.now() >= session.tokenExpiresAt) {
      logger.debug('Session expired locally (tokenExpiresAt)');
      return false;
    }

    // Also check JWT expiry as a backup
    try {
      const decoded = jwtDecode<{ exp?: number }>(session.accessToken);
      if (decoded.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (decoded.exp <= now) {
          logger.debug('Session expired locally (JWT exp)');
          return false;
        }
      }
    } catch {
      // Token isn't a JWT or can't be decoded — assume valid for now
    }

    // Remote validation: lightweight API call to verify session
    if (remoteCheck) {
      try {
        // Import UserApiClient here to avoid circular dependencies
        const { UserApiClient } = await import('../api/user');
        const userApi = new UserApiClient();
        await userApi.getUser(); // Lightweight endpoint
        logger.debug('Session validated remotely (API call succeeded)');
        return true;
      } catch (error: any) {
        if (error?.response?.status === 401 || error?.response?.status === 403) {
          logger.debug('Session invalid remotely (401/403)');
          return false;
        }
        // Network error or other issue — assume session is valid
        // The actual operation will retry if the session is truly invalid
        logger.warn('Session validation failed due to network error, assuming valid');
        return true;
      }
    }

    // Local validation passed
    return true;
  }

  /**
   * Get an existing session or create a new one via SRP authentication.
   * This method implements session reuse: if a valid session exists, it is returned
   * immediately without performing SRP auth. This significantly reduces auth overhead.
   *
   * @param username - Username for authentication (if new session needed)
   * @param password - Password for authentication (if new session needed)
   * @param remoteCheck - If true, validates existing session with an API call
   * @returns Valid session (existing or newly created)
   */
  static async getOrCreateSession(
    username: string,
    password: string,
    remoteCheck: boolean = false
  ): Promise<SessionCredentials> {
    const existing = await this.loadSession();

    if (existing) {
      // Check if the session belongs to the same user
      const expectedHash = this.hashUsername(username);
      if (existing.userHash && existing.userHash !== expectedHash) {
        logger.info('Existing session belongs to different user, creating new session...');
      } else {
        logger.debug('Found existing session, validating...');
        const isValid = await this.validateSession(existing, remoteCheck);
        if (isValid) {
          logger.info('Reusing existing valid session (skipping SRP auth)');
          return existing;
        }
        logger.info('Existing session invalid, creating new session...');
      }
    }

    // No session or invalid session — perform full SRP auth
    logger.info('Performing SRP authentication...');
    const { AuthService } = await import('./index');
    const authService = new AuthService();
    return await authService.login(username, password);
  }

  // ─── Crypto-init cache ──────────────────────────────────────────────

  /**
   * Load cached crypto-init API responses (keySalts, user, addresses).
   * Returns null if cache is missing, corrupted, or belongs to a different session.
   */
  static async loadCryptoCache(): Promise<CryptoCache | null> {
    try {
      if (!await fs.pathExists(CRYPTO_CACHE_FILE)) return null;

      const cache: CryptoCache = await fs.readJson(CRYPTO_CACHE_FILE);
      if (!cache.sessionUid || !cache.keySalts || !cache.user || !cache.addresses) {
        logger.debug('Crypto cache invalid (missing fields)');
        return null;
      }

      // Validate cache belongs to current session
      const session = await this.loadSession();
      if (!session || session.uid !== cache.sessionUid) {
        logger.debug('Crypto cache stale (session UID mismatch)');
        await this.clearCryptoCache();
        return null;
      }

      logger.debug('Crypto cache loaded (skipping 3 API calls)');
      return cache;
    } catch {
      return null;
    }
  }

  /**
   * Save crypto-init API responses to disk.
   * Tied to the current session UID so it auto-invalidates on re-login.
   */
  static async saveCryptoCache(
    sessionUid: string,
    keySalts: Array<{ ID: string; KeySalt: string | null }>,
    user: any,
    addresses: any[],
  ): Promise<void> {
    try {
      await fs.ensureDir(SESSION_DIR, { mode: 0o700 });
      const cache: CryptoCache = {
        sessionUid,
        keySalts,
        user,
        addresses,
        cachedAt: new Date().toISOString(),
      };
      const suffix = `${process.pid}-${randomBytes(4).toString('hex')}`;
      const tmpFile = `${CRYPTO_CACHE_FILE}.tmp-${suffix}`;
      try {
        await fs.writeJson(tmpFile, cache, { spaces: 2, mode: 0o600 });
        await fs.move(tmpFile, CRYPTO_CACHE_FILE, { overwrite: true });
      } catch (writeErr) {
        await fs.remove(tmpFile).catch(() => {});
        throw writeErr;
      }
      logger.debug('Crypto cache saved');
    } catch (err) {
      // Non-fatal — next subprocess will just make the API calls
      logger.debug(`Failed to save crypto cache: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Clear the crypto cache (e.g. on logout or session change).
   */
  static async clearCryptoCache(): Promise<void> {
    try {
      if (await fs.pathExists(CRYPTO_CACHE_FILE)) {
        await fs.remove(CRYPTO_CACHE_FILE);
      }
    } catch {
      // Non-fatal
    }
  }
}
