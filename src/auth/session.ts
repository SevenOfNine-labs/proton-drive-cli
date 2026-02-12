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
const CRYPTO_CACHE_FILE = path.join(SESSION_DIR, 'crypto-cache.json');

export interface CryptoCache {
  sessionUid: string;
  keySalts: Array<{ ID: string; KeySalt: string | null }>;
  user: any;
  addresses: any[];
  cachedAt: string;
}

export class SessionManager {
  /**
   * Save session credentials to disk
   * @param session - Session credentials to save
   */
  static async saveSession(session: SessionCredentials): Promise<void> {
    try {
      // Ensure directory exists with owner-only permissions
      await fs.ensureDir(SESSION_DIR, { mode: 0o700 });

      // Strip mailboxPassword — passwords are never persisted to disk.
      // The password flows via stdin on every bridge invocation (from pass-cli).
      const { mailboxPassword, ...safeSession } = session as SessionCredentials & { mailboxPassword?: string };

      // Write atomically: unique temp file with restrictive mode, then rename.
      // Unique suffix prevents corruption from concurrent saveSession calls.
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
