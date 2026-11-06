import * as fs from 'fs-extra';
import { lock } from 'proper-lockfile';
import { AuthApiClient } from '../api/auth';
import { SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';
import { writePrivateJsonFile } from './private-json-file';
import { CRYPTO_CACHE_FILE, SESSION_FILE, SESSION_LOCK_PATH, STATE_DIR } from './state-dir';
import { isAccessTokenExpired, isAccessTokenExpiringSoon, resolveTokenExpiresAt } from './token-expiry';

/**
 * Session manager for storing and retrieving authentication credentials
 * Stores session data in ~/.proton-drive-cli/session.json
 *
 * Also manages a crypto-init cache (crypto-cache.json) that stores the
 * raw API responses for keySalts, user, and addresses. These are encrypted
 * (armored PGP keys) and safe to persist — the password is required at
 * runtime to decrypt them. This eliminates 3 API round-trips per subprocess.
 */

export interface CryptoCache {
  sessionUid: string;
  keySalts: Array<{ ID: string; KeySalt: string | null }>;
  user: any;
  addresses: any[];
  cachedAt: string;
}

/**
 * Lifetime of crypto-cache.json. The cached user and address records carry
 * the key lists, so a key added or rotated from another device is only seen
 * once the cache expires; one hour bounds that staleness at the cost of
 * three API calls per hour across all bridge subprocesses.
 */
export const CRYPTO_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Lock options for refresh-token rotation (proper-lockfile): a holder keeps
 * the lock's mtime fresh every `stale / 2` ms, so a live refresh (HTTP
 * timeout 15 s) never looks stale, while a crashed holder is evicted after
 * `stale` ms. Waiters retry for about 30 s, longer than one refresh call.
 */
const SESSION_LOCK_OPTIONS = {
  lockfilePath: SESSION_LOCK_PATH,
  realpath: false,
  stale: 30_000,
  retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2_000 },
  onCompromised: (error: Error) => {
    logger.warn(`Session lock compromised: ${error.message}`);
  },
};

export class SessionManager {
  /**
   * Run `fn` while holding the cross-process session lock. Every bridge
   * subprocess shares session.json; the lock serialises refresh-token
   * rotation so only one process consumes the single-use refresh token.
   */
  private static async withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.ensureDir(STATE_DIR, { mode: 0o700 });
    const release = await lock(SESSION_FILE, SESSION_LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      await release().catch((error) => {
        logger.warn('Failed to release session lock:', error);
      });
    }
  }

  /**
   * Save session credentials to disk under the session lock.
   * @param session - Session credentials to save
   */
  static async saveSession(session: SessionCredentials): Promise<void> {
    try {
      await this.withSessionLock(() => this.writeSessionFile(session));
    } catch (error) {
      throw new Error(`Failed to save session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private static async writeSessionFile(session: SessionCredentials): Promise<void> {
    // Strip mailboxPassword — passwords are never persisted to disk.
    // The password flows via stdin on every bridge invocation (from pass-cli).
    const { mailboxPassword, ...safeSession } = session as SessionCredentials & { mailboxPassword?: string };
    await writePrivateJsonFile(SESSION_FILE, safeSession);
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
      // Under the session lock, so a refresh that already loaded the session
      // cannot write it back after logout (refreshSession re-reads the file
      // under the same lock and refuses when it is gone).
      await this.withSessionLock(async () => {
        if (await fs.pathExists(SESSION_FILE)) {
          await fs.remove(SESSION_FILE);
        }
      });
    } catch (error) {
      throw new Error(`Failed to clear session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if a saved session exists whose access token has not expired locally.
   */
  static async hasValidSession(): Promise<boolean> {
    const session = await this.loadSession();
    if (!session) return false;

    if (isAccessTokenExpired(session)) {
      logger.debug('Session access token has expired');
      return false;
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
   * Get session file path
   * @returns Path to session file
   */
  static getSessionFilePath(): string {
    return SESSION_FILE;
  }

  /**
   * Refresh session tokens using the refresh token.
   *
   * Runs under the session lock and works on the session file as it is at
   * that moment: a session that another process already rotated is returned
   * as-is, and a session that was logged out meanwhile is not resurrected
   * from the caller's copy.
   *
   * @param expectedSession - Session observed by the caller before locking
   * @returns Updated session with new tokens
   */
  static async refreshSession(expectedSession?: SessionCredentials, appVersion?: string): Promise<SessionCredentials> {
    return this.withSessionLock(async () => {
      const session = await this.loadSession();
      if (!session) {
        throw new Error('No session to refresh');
      }

      if (
        expectedSession &&
        (session.accessToken !== expectedSession.accessToken ||
          session.refreshToken !== expectedSession.refreshToken) &&
        !isAccessTokenExpired(session)
      ) {
        logger.info('Session was already refreshed by another process');
        return session;
      }

      const authApi = new AuthApiClient(undefined, appVersion);

      logger.debug(`Refreshing tokens for session ${session.uid}`);
      const result = await authApi.refreshToken(session.uid, session.refreshToken);

      const updatedSession: SessionCredentials = {
        ...session,
        accessToken: result.AccessToken,
        refreshToken: result.RefreshToken,
        tokenExpiresAt: resolveTokenExpiresAt(result.ExpiresIn),
      };

      await this.writeSessionFile(updatedSession);
      logger.info('Token refreshed successfully');
      return updatedSession;
    });
  }

  /**
   * Refresh the session, or adopt the tokens another process wrote while
   * this one failed: the refresh token is single-use, so when a refresh is
   * rejected the session file is re-read and a rotated token pair wins over
   * the failure.
   *
   * @param session - Session whose tokens were rejected
   */
  static async refreshSessionOrAdoptRotated(
    session: SessionCredentials,
    appVersion?: string,
  ): Promise<SessionCredentials> {
    try {
      return await this.refreshSession(session, appVersion);
    } catch (error) {
      const latest = await this.loadSession();
      if (latest && latest.accessToken !== session.accessToken) {
        logger.info('Session refreshed by another process, using updated tokens');
        return latest;
      }
      throw error;
    }
  }

  /**
   * Get a valid session, proactively refreshing tokens if they are expiring soon.
   * This method should be called before operations to ensure the token is valid
   * for the duration of the operation (preventing mid-operation expiration).
   *
   * @returns Valid session or null if no session exists
   */
  static async getValidSession(appVersion?: string): Promise<SessionCredentials | null> {
    const session = await this.loadSession();
    if (!session) return null;

    if (isAccessTokenExpiringSoon(session)) {
      logger.info('Token expiring soon, proactively refreshing...');
      try {
        return await this.refreshSession(session, appVersion);
      } catch (error) {
        logger.warn('Proactive refresh failed, token may expire during operation:', error);
        // The current tokens are kept: the request may still succeed, and an
        // HTTP 401 triggers the reactive refresh.
        return session;
      }
    }

    return session;
  }

  /**
   * Local validity check: the access token has not reached `tokenExpiresAt`.
   * The API's HTTP 401 is the remote verdict and drives the reactive refresh.
   */
  static async validateSession(session: SessionCredentials): Promise<boolean> {
    if (isAccessTokenExpired(session)) {
      logger.debug('Session expired locally (tokenExpiresAt)');
      return false;
    }
    return true;
  }

  // ─── Crypto-init cache ──────────────────────────────────────────────

  /**
   * Load cached crypto-init API responses (keySalts, user, addresses).
   * Returns null if the cache is missing, corrupted, older than
   * CRYPTO_CACHE_TTL_MS, or belongs to a different session.
   */
  static async loadCryptoCache(now: number = Date.now()): Promise<CryptoCache | null> {
    try {
      if (!await fs.pathExists(CRYPTO_CACHE_FILE)) return null;

      const cache: CryptoCache = await fs.readJson(CRYPTO_CACHE_FILE);
      if (!cache.sessionUid || !cache.keySalts || !cache.user || !cache.addresses) {
        logger.debug('Crypto cache invalid (missing fields)');
        return null;
      }

      const cachedAt = Date.parse(cache.cachedAt);
      if (!Number.isFinite(cachedAt) || now - cachedAt >= CRYPTO_CACHE_TTL_MS) {
        logger.debug('Crypto cache expired');
        await this.clearCryptoCache();
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
      const cache: CryptoCache = {
        sessionUid,
        keySalts,
        user,
        addresses,
        cachedAt: new Date().toISOString(),
      };
      await writePrivateJsonFile(CRYPTO_CACHE_FILE, cache);
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
