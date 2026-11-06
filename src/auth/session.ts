import * as fs from 'fs-extra';
import { lock } from 'proper-lockfile';
import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { toAppError } from '../errors/classify';
import { AppError, ErrorCode } from '../errors/types';
import { SessionCredentials } from '../types/auth';
import type { Address, User } from '../types/crypto';
import { normalizeProviderName } from '../credentials';
import { logger } from '../utils/logger';
import { createKeyPasswordStore } from './key-password-store';
import { writePrivateJsonFile } from './private-json-file';
import { CRYPTO_CACHE_FILE, SESSION_FILE, SESSION_LOCK_PATH, STATE_DIR } from './state-dir';
import { isAccessTokenExpired, resolveTokenExpiresAt } from './token-expiry';
import { uidFingerprint } from '../utils/redaction';

export interface CryptoCache {
  sessionUid: string;
  user: User;
  addresses: Address[];
  cachedAt: string;
}

/** Content of session.json: absent, not a session this CLI's login writes, or a session. */
export type StoredSession =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'valid'; session: SessionCredentials };

/** The session a request was sent with: its UID and access token. */
export type SessionTokens = Pick<SessionCredentials, 'uid' | 'accessToken'>;

function isCanonicalProviderName(value: string): boolean {
  try {
    return normalizeProviderName(value) === value;
  } catch {
    return false;
  }
}

/**
 * True for an object carrying every field `proton-drive-cli login` writes,
 * each a non-blank string: uid, accessToken, refreshToken, keyPasswordProvider
 * (`git-credential` or `pass-cli`) and keyPasswordHost.
 */
export function isSessionCredentials(value: unknown): value is SessionCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return ['uid', 'accessToken', 'refreshToken', 'keyPasswordProvider', 'keyPasswordHost'].every(
    (field) => typeof candidate[field] === 'string' && candidate[field].trim() !== '',
  ) && isCanonicalProviderName(candidate.keyPasswordProvider as string);
}

/**
 * A refresh the API rejected: a Proton error body (numeric `Code`) with HTTP
 * 4xx other than 408 (RFC 9110, 15.5.9) and 429 (RFC 6585, 4). The official
 * ApiClient.performTokenRefresh (apiClient.ts) signs out on every 4xx but 429.
 */
function isRefreshRejection(error: unknown): boolean {
  if (!isHttpClientError(error) || error.code === 'RATE_LIMITED') {
    return false;
  }
  const status = error.response?.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429 &&
    typeof error.response?.data?.Code === 'number';
}

/** Error reported after a refresh signed the session out. */
function signedOutError(cause: unknown, reason: string): AppError {
  const classified = toAppError(cause);
  return new AppError(
    `${reason}; the session was signed out. Run: proton-drive-cli login`,
    ErrorCode.SESSION_EXPIRED,
    { ...classified.details, signedOut: true },
    false,
  );
}

function lockLostError(event: string): AppError {
  return new AppError(
    `The session lock was lost while ${event}; the session was kept. Rerun the command`,
    ErrorCode.UNKNOWN_ERROR,
    { lockCompromised: true },
    false,
  );
}

function sessionReplacedError(): AppError {
  return new AppError(
    'session.json now holds another login session; rerun the command',
    ErrorCode.SESSION_EXPIRED,
    {},
    false,
  );
}

/**
 * Lifetime of crypto-cache.json, counted from the fetch of its records: a key
 * added or rotated on another device is seen at the latest one TTL later.
 */
export const CRYPTO_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * proper-lockfile: the holder renews the lock's mtime every `stale / 2` ms and
 * a holder silent for `stale` ms is evicted; waiters retry for about 30 s.
 */
const SESSION_LOCK_OPTIONS = {
  lockfilePath: SESSION_LOCK_PATH,
  realpath: false,
  stale: 30_000,
  retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 2_000 },
};

/** A held session lock; `compromised` once proper-lockfile reported it lost. */
interface HeldSessionLock {
  readonly compromised: boolean;
}

/** In-process refresh of one rejected access token, shared by concurrent callers. */
interface PendingRefresh {
  promise: Promise<SessionCredentials>;
  failedAt?: number;
}

/**
 * A rate-limited or signed-out refresh of a rejected token is reused this
 * long; any other failure leaves the next caller free to retry.
 */
const REFRESH_FAILURE_HOLD_MS = 30_000;

function holdsRefreshFailure(error: unknown): boolean {
  const code = toAppError(error).code;
  return code === ErrorCode.RATE_LIMITED || code === ErrorCode.SESSION_EXPIRED;
}

/**
 * Persistence of the browser-fork session (session.json) and of the
 * crypto-init cache (crypto-cache.json: the user and address records with
 * their armored, passphrase-protected keys, shared by bridge subprocesses).
 */
export class SessionManager {
  /**
   * Run `fn` while holding the cross-process session lock, which serialises
   * the rotation of the single-use refresh token across bridge subprocesses.
   */
  private static async withSessionLock<T>(fn: (held: HeldSessionLock) => Promise<T>): Promise<T> {
    await fs.ensureDir(STATE_DIR, { mode: 0o700 });
    const held = { compromised: false };
    const release = await lock(SESSION_FILE, {
      ...SESSION_LOCK_OPTIONS,
      onCompromised: (error: Error) => {
        held.compromised = true;
        logger.warn(`Session lock compromised: ${error.message}`);
      },
    });
    try {
      return await fn(held);
    } finally {
      await release().catch((error) => {
        logger.warn('Failed to release session lock:', error);
      });
    }
  }

  /**
   * Save `session` under the session lock and return the valid session it
   * replaced, read under the same lock, or null.
   */
  static async replaceSession(session: SessionCredentials): Promise<SessionCredentials | null> {
    try {
      return await this.withSessionLock(async () => {
        const previous = await this.readStoredSession();
        await this.writeSessionFile(session);
        return previous.kind === 'valid' ? previous.session : null;
      });
    } catch (error) {
      throw new Error(`Failed to save session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private static async writeSessionFile(session: SessionCredentials): Promise<void> {
    await writePrivateJsonFile(SESSION_FILE, session);
  }

  /**
   * Read session.json and classify it. A file that cannot be parsed or lacks
   * a field of {@link isSessionCredentials} is `invalid`.
   */
  static async readStoredSession(sessionFile: string = SESSION_FILE): Promise<StoredSession> {
    if (!await fs.pathExists(sessionFile)) {
      return { kind: 'none' };
    }
    try {
      const session: unknown = await fs.readJson(sessionFile);
      return isSessionCredentials(session) ? { kind: 'valid', session } : { kind: 'invalid' };
    } catch (error) {
      logger.debug(`Session file unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: 'invalid' };
    }
  }

  /**
   * Load session credentials from disk
   * @returns Session credentials, or null when there is no valid session
   */
  static async loadSession(): Promise<SessionCredentials | null> {
    try {
      const stored = await this.readStoredSession();
      if (stored.kind === 'valid') {
        return stored.session;
      }
      if (stored.kind === 'invalid') {
        logger.warn('Session file is not a proton-drive-cli login session. Run: proton-drive-cli login');
      }
    } catch (error) {
      logger.error('Failed to load session:', error instanceof Error ? error.message : 'Unknown error');
    }
    return null;
  }

  /**
   * Under the session lock, delete session.json and the crypto cache: with
   * `endedUid`, only while the file holds that UID's session or no valid
   * session, so a login that replaced it survives; without, unconditionally.
   * A refresh in flight re-reads the file before writing and never recreates it.
   *
   * @returns true when the files were deleted
   */
  static async clearSession(endedUid?: string): Promise<boolean> {
    try {
      return await this.withSessionLock(async () => {
        const stored = await this.readStoredSession();
        if (endedUid !== undefined && stored.kind === 'valid' && stored.session.uid !== endedUid) {
          return false;
        }
        await fs.remove(SESSION_FILE);
        await this.clearCryptoCache();
        return true;
      });
    } catch (error) {
      throw new Error(`Failed to clear session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** {@link clearSession} only while session.json holds no valid session. */
  static async clearInvalidSession(): Promise<boolean> {
    try {
      return await this.withSessionLock(async () => {
        if ((await this.readStoredSession()).kind === 'valid') {
          return false;
        }
        await fs.remove(SESSION_FILE);
        await this.clearCryptoCache();
        return true;
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
   * Get session file path
   * @returns Path to session file
   */
  static getSessionFilePath(): string {
    return SESSION_FILE;
  }

  /**
   * Refresh session tokens using the refresh token.
   *
   * Runs under the session lock on the session file as it is at that moment.
   * When `stale` names another UID, the file holds a new login and nothing is
   * refreshed. When the file's access token differs from `stale.accessToken`,
   * another process already refreshed and that session is returned without
   * spending the refresh token (official ApiClient.refreshSessionIfPossible).
   * The new tokens are written only while the file still holds the refresh
   * token that was spent, so a logout or a sign-out during the request is
   * never undone; that check also holds when the lock was reported lost.
   *
   * A refresh the API rejects (see {@link isRefreshRejection}), or answers
   * with another UID, while the file still holds the spent refresh token signs
   * the session out like the official SessionCredentials.signOut: session
   * file, crypto cache and key-password entry are removed and SESSION_EXPIRED
   * is thrown. A lost lock keeps the session instead.
   *
   * @param stale - UID and access token the caller observed or had rejected
   * @returns Updated session with new tokens
   */
  static async refreshSession(stale?: SessionTokens, appVersion?: string): Promise<SessionCredentials> {
    type Outcome =
      | { kind: 'session'; session: SessionCredentials }
      | { kind: 'signed-out'; session: SessionCredentials; cause: unknown; reason: string };
    const outcome = await this.withSessionLock(async (held): Promise<Outcome> => {
      const session = await this.loadSession();
      if (!session) {
        throw new AppError('No session to refresh. Run: proton-drive-cli login', ErrorCode.SESSION_EXPIRED, {}, false);
      }
      if (stale !== undefined && session.uid !== stale.uid) {
        throw sessionReplacedError();
      }
      if (stale !== undefined && session.accessToken !== stale.accessToken && !isAccessTokenExpired(session)) {
        logger.info('Session was already refreshed by another process');
        return { kind: 'session', session };
      }

      const authApi = new AuthApiClient(undefined, appVersion);

      logger.debug('Refreshing session tokens');
      let result;
      try {
        result = await authApi.refreshToken(session.uid, session.accessToken, session.refreshToken);
      } catch (error) {
        if (isRefreshRejection(error)) {
          if (await this.signOutIfUnchanged(session, held)) {
            return { kind: 'signed-out', session, cause: error, reason: 'Proton rejected the refresh token' };
          }
          if (held.compromised) {
            throw lockLostError('Proton rejected the refresh token');
          }
        }
        throw error;
      }
      if (result.UID !== session.uid) {
        await authApi.logout(result.UID, result.AccessToken).catch((revokeError: unknown) => {
          logger.warn(`Could not revoke the session of the refresh response ${uidFingerprint(result.UID)}: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`);
        });
        const cause = new AppError(
          'The refresh response names another session UID',
          ErrorCode.AUTH_FAILED,
          {},
          false,
        );
        if (await this.signOutIfUnchanged(session, held)) {
          return { kind: 'signed-out', session, cause, reason: cause.message };
        }
        throw held.compromised ? lockLostError('the refresh response named another session UID') : cause;
      }

      const current = await this.readStoredSession();
      if (current.kind !== 'valid') {
        throw new AppError(
          'The session was removed during the refresh. Run: proton-drive-cli login',
          ErrorCode.SESSION_EXPIRED,
          {},
          false,
        );
      }
      if (current.session.refreshToken !== session.refreshToken) {
        if (current.session.uid !== session.uid) {
          throw sessionReplacedError();
        }
        logger.info('Session was rotated by another process during the refresh');
        return { kind: 'session', session: current.session };
      }

      const updatedSession: SessionCredentials = {
        ...session,
        accessToken: result.AccessToken,
        refreshToken: result.RefreshToken,
        tokenExpiresAt: resolveTokenExpiresAt(result.ExpiresIn),
      };
      await this.writeSessionFile(updatedSession);
      logger.info('Token refreshed successfully');
      return { kind: 'session', session: updatedSession };
    });

    if (outcome.kind === 'session') {
      return outcome.session;
    }
    await this.removeKeyPassword(outcome.session);
    throw signedOutError(outcome.cause, outcome.reason);
  }

  /**
   * Under the session lock: delete session.json and the crypto cache when the
   * file still holds the refresh token of `session` and the lock was not
   * reported lost; true when it did.
   */
  private static async signOutIfUnchanged(session: SessionCredentials, held: HeldSessionLock): Promise<boolean> {
    if (held.compromised) {
      return false;
    }
    const current = await this.loadSession();
    if (!current || current.refreshToken !== session.refreshToken) {
      return false;
    }
    logger.warn('Signing out the session after a rejected refresh');
    await fs.remove(SESSION_FILE);
    await this.clearCryptoCache();
    return true;
  }

  /** Remove the key-password entry of `session`; failures are logged. */
  static async removeKeyPassword(session: SessionCredentials): Promise<void> {
    try {
      await createKeyPasswordStore({
        provider: session.keyPasswordProvider,
        host: session.keyPasswordHost,
      }).remove(session.uid);
    } catch (error) {
      logger.warn(`Could not remove the key password of session ${uidFingerprint(session.uid)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private static readonly pendingRefreshes = new Map<string, PendingRefresh>();

  /**
   * Refresh the session, or adopt the tokens another process wrote for the
   * same UID while this one failed: the refresh token is single-use, so a
   * rotated token pair wins over the failure. Concurrent callers in this
   * process share one refresh per rejected token, and a rate-limited or
   * signed-out failure is reused for REFRESH_FAILURE_HOLD_MS.
   *
   * @param rejected - UID and access token the API answered with HTTP 401
   */
  static refreshSessionOrAdoptRotated(
    rejected: SessionTokens,
    appVersion?: string,
  ): Promise<SessionCredentials> {
    const key = `${rejected.uid}\n${rejected.accessToken}`;
    const existing = this.pendingRefreshes.get(key);
    if (existing && (existing.failedAt === undefined || Date.now() - existing.failedAt < REFRESH_FAILURE_HOLD_MS)) {
      return existing.promise;
    }
    const pending: PendingRefresh = { promise: this.refreshOrAdopt(rejected, appVersion) };
    this.pendingRefreshes.set(key, pending);
    pending.promise.then(
      () => {
        if (this.pendingRefreshes.get(key) === pending) {
          this.pendingRefreshes.delete(key);
        }
      },
      (error) => {
        if (holdsRefreshFailure(error)) {
          pending.failedAt = Date.now();
        } else if (this.pendingRefreshes.get(key) === pending) {
          this.pendingRefreshes.delete(key);
        }
      },
    );
    return pending.promise;
  }

  private static async refreshOrAdopt(rejected: SessionTokens, appVersion?: string): Promise<SessionCredentials> {
    try {
      return await this.refreshSession(rejected, appVersion);
    } catch (error) {
      const latest = await this.loadSession();
      if (latest && latest.uid === rejected.uid && latest.accessToken !== rejected.accessToken) {
        logger.info('Session refreshed by another process, using updated tokens');
        return latest;
      }
      throw error;
    }
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
   * Load the cached user and address records.
   * Returns null if the cache is missing, corrupted, older than
   * CRYPTO_CACHE_TTL_MS, or belongs to a different session.
   */
  static async loadCryptoCache(now: number = Date.now()): Promise<CryptoCache | null> {
    try {
      if (!await fs.pathExists(CRYPTO_CACHE_FILE)) return null;

      const cache: CryptoCache = await fs.readJson(CRYPTO_CACHE_FILE);
      if (!cache.sessionUid || !cache.user || !Array.isArray(cache.addresses)) {
        logger.debug('Crypto cache invalid (missing fields)');
        return null;
      }

      const cachedAt = Date.parse(cache.cachedAt);
      if (!Number.isFinite(cachedAt) || now - cachedAt >= CRYPTO_CACHE_TTL_MS) {
        logger.debug('Crypto cache expired');
        await this.clearCryptoCache();
        return null;
      }

      const session = await this.loadSession();
      if (!session || session.uid !== cache.sessionUid) {
        logger.debug('Crypto cache stale (session UID mismatch)');
        await this.clearCryptoCache();
        return null;
      }

      logger.debug('Crypto cache loaded');
      return cache;
    } catch {
      return null;
    }
  }

  /**
   * Save the user and address records fetched under `sessionUid`, under the
   * session lock and only while session.json holds that UID's session, so a
   * logout or a new login during the fetch leaves no stale cache behind.
   */
  static async saveCryptoCache(
    sessionUid: string,
    user: User,
    addresses: Address[],
  ): Promise<void> {
    try {
      await this.withSessionLock(async () => {
        const stored = await this.readStoredSession();
        if (stored.kind !== 'valid' || stored.session.uid !== sessionUid) {
          logger.debug('Crypto cache not saved: the session changed during the fetch');
          return;
        }
        const cache: CryptoCache = {
          sessionUid,
          user,
          addresses,
          cachedAt: new Date().toISOString(),
        };
        await writePrivateJsonFile(CRYPTO_CACHE_FILE, cache);
        logger.debug('Crypto cache saved');
      });
    } catch (err) {
      logger.debug(`Failed to save crypto cache: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Delete the crypto cache; a failure leaves a cache that expires on its own. */
  static async clearCryptoCache(): Promise<void> {
    await fs.remove(CRYPTO_CACHE_FILE).catch((error: unknown) => {
      logger.debug(`Failed to clear crypto cache: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
