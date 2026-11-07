import { randomUUID } from 'crypto';
import * as fs from 'fs-extra';
import pRetry from 'p-retry';
import { lock } from 'proper-lockfile';
import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { toAppError } from '../errors/classify';
import { AppError, ErrorCode } from '../errors/types';
import type { SessionCredentials, SessionRecord, SessionSecrets } from '../types/auth';
import type { Address, User } from '../types/crypto';
import { normalizeCredentialStoreName } from '../credentials';
import { logger } from '../utils/logger';
import { createSessionSecretStore, type StoredSessionSecrets } from './session-secrets';
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
  | { kind: 'valid'; record: SessionRecord };

/**
 * The session a request was sent with: its UID and access token, and the
 * revision those came from when the caller knows it.
 */
export type SessionTokens = Pick<SessionCredentials, 'uid' | 'accessToken'> & { revision?: string };

function isCanonicalStoreName(value: string): boolean {
  try {
    return normalizeCredentialStoreName(value) === value;
  } catch {
    return false;
  }
}

/**
 * True for an object carrying every field `proton-drive-cli login` writes to
 * session.json, each a non-blank string: uid, credentialStore
 * (`git-credential` or `pass-cli`), credentialHost and revision.
 */
export function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return ['uid', 'credentialStore', 'credentialHost', 'revision'].every(
    (field) => typeof candidate[field] === 'string' && candidate[field].trim() !== '',
  ) && isCanonicalStoreName(candidate.credentialStore as string);
}

/** The fields of {@link SessionRecord} in a value that {@link isSessionRecord} accepts. */
function toSessionRecord(value: SessionRecord): SessionRecord {
  const scopes = Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === 'string')
    ? value.scopes
    : undefined;
  return {
    uid: value.uid,
    ...(scopes ? { scopes } : {}),
    credentialStore: value.credentialStore,
    credentialHost: value.credentialHost,
    revision: value.revision,
    ...(typeof value.tokenExpiresAt === 'number' ? { tokenExpiresAt: value.tokenExpiresAt } : {}),
  };
}

function secretStoreOf(record: SessionRecord) {
  return createSessionSecretStore({ store: record.credentialStore, host: record.credentialHost });
}

function credentialsUnavailableError(
  record: SessionRecord,
  message: string,
  cause: unknown,
  remedy = 'Fix the credential store, or run: proton-drive-cli login',
): AppError {
  const storeError = cause instanceof Error ? cause.message : String(cause);
  return new AppError(
    `${message} (${storeError}). ${remedy}`,
    ErrorCode.CREDENTIALS_UNAVAILABLE,
    { credentialStore: record.credentialStore, credentialHost: record.credentialHost, storeError },
    true,
  );
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

/** Error reported after a refresh signed the session out; `credentialsRemoved` tells whether its entry is gone. */
function signedOutError(cause: unknown, reason: string, credentialsRemoved: boolean): AppError {
  const classified = toAppError(cause);
  return new AppError(
    `${reason}; the session was signed out. Run: proton-drive-cli login`,
    ErrorCode.SESSION_EXPIRED,
    { ...classified.details, signedOut: true, credentialsRemoved },
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
 * a holder silent for `stale` ms is evicted; waiters retry for about two
 * minutes, the length of a refresh that saves to a remote credential store.
 */
const SESSION_LOCK_OPTIONS = {
  lockfilePath: SESSION_LOCK_PATH,
  realpath: false,
  stale: 30_000,
  retries: { retries: 30, factor: 1.5, minTimeout: 100, maxTimeout: 5_000 },
};

/** A held session lock; `compromised` once proper-lockfile reported it lost. */
interface HeldSessionLock {
  readonly compromised: boolean;
}

/** Secrets of one session revision as this process read or wrote them. */
interface LoadedSecrets {
  uid: string;
  revision: string;
  secrets: SessionSecrets;
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

/** Retries of a credential-store save (p-retry), at most 30 s: the store is remote for pass-cli. */
const STORE_SAVE_RETRY = { retries: 3, minTimeout: 1_000, factor: 2, maxRetryTime: 30_000 };

function holdsRefreshFailure(error: unknown): boolean {
  const code = toAppError(error).code;
  return code === ErrorCode.RATE_LIMITED || code === ErrorCode.SESSION_EXPIRED;
}

/**
 * Persistence of the browser-fork session and of the crypto-init cache
 * (crypto-cache.json: the user and address records with their armored,
 * passphrase-protected keys, shared by bridge subprocesses). A session is
 * session.json (owner-only, no secret) plus the credential-store entry of its
 * UID; every write stores the entry first, then session.json with a new
 * revision, both under the session lock.
 */
export class SessionManager {
  /** Secrets this process read or wrote last, by session UID and the revision stored with them. */
  private static loaded: LoadedSecrets | null = null;

  /** A store read in flight for one session.json revision, shared by concurrent callers. */
  private static loading: { key: string; secrets: Promise<SessionSecrets> } | null = null;

  /** Secrets of `record`, read from the credential store unless this process holds its revision. */
  private static secretsOf(record: SessionRecord): Promise<SessionSecrets> {
    const current = this.loaded;
    if (current?.uid === record.uid && current.revision === record.revision) {
      return Promise.resolve(current.secrets);
    }
    const key = `${record.uid}\n${record.revision}`;
    if (this.loading?.key === key) {
      return this.loading.secrets;
    }
    const secrets = this.readEntry(record).then((stored) => stored.secrets);
    const loading = { key, secrets };
    this.loading = loading;
    secrets.then(
      () => this.clearLoading(loading),
      () => this.clearLoading(loading),
    );
    return secrets;
  }

  /** The entry of `record`, remembered as this process's secrets of the revision stored in it. */
  private static async readEntry(record: SessionRecord): Promise<StoredSessionSecrets> {
    let stored: StoredSessionSecrets;
    try {
      stored = await secretStoreOf(record).load(record.uid);
    } catch (error) {
      throw credentialsUnavailableError(record, `The credentials of the session could not be read from ${record.credentialStore}`, error);
    }
    this.loaded = { uid: record.uid, revision: stored.revision, secrets: stored.secrets };
    return stored;
  }

  /**
   * Under the session lock: `record` with the secrets of an entry that carries
   * its revision. An entry that replaces it completes a write interrupted
   * before session.json; any other entry is refused, so its token is never spent.
   */
  private static async verifiedSession(record: SessionRecord): Promise<SessionCredentials> {
    const stored = await this.readEntry(record);
    if (stored.revision === record.revision) {
      return { ...record, ...stored.secrets };
    }
    if (stored.previous !== record.revision) {
      throw credentialsUnavailableError(
        record,
        `The ${record.credentialStore} entry does not belong to session.json`,
        new Error(`entry revision ${stored.revision}, session.json revision ${record.revision}`),
      );
    }
    const completed = toSessionRecord({ ...record, revision: stored.revision, tokenExpiresAt: undefined });
    await writePrivateJsonFile(SESSION_FILE, completed);
    logger.warn('Completed a session write that saved the credentials but not session.json');
    return { ...completed, ...stored.secrets };
  }

  private static clearLoading(loading: { key: string; secrets: Promise<SessionSecrets> }): void {
    if (this.loading === loading) {
      this.loading = null;
    }
  }

  /** The revision `stale` was loaded from: its own, or the one this process loaded with its access token. */
  private static revisionOf(stale: SessionTokens): string | undefined {
    if (stale.revision !== undefined) {
      return stale.revision;
    }
    const current = this.loaded;
    return current?.uid === stale.uid && current.secrets.accessToken === stale.accessToken
      ? current.revision
      : undefined;
  }

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
   * Save `session` under the session lock and return it with its revision,
   * together with the valid session record it replaced, read under the same
   * lock, or null.
   *
   * @throws AppError CREDENTIALS_UNAVAILABLE when the credential store does not save the secrets
   */
  static async replaceSession(
    session: Omit<SessionCredentials, 'revision'>,
  ): Promise<{ session: SessionCredentials; previous: SessionRecord | null }> {
    try {
      return await this.withSessionLock(async () => {
        const previous = await this.readStoredSession();
        const saved = await this.writeSession(session, undefined);
        return { session: saved, previous: previous.kind === 'valid' ? previous.record : null };
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new Error(`Failed to save session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Under the session lock, store the secrets (read back, retried), then
   * session.json; a store failure is CREDENTIALS_UNAVAILABLE.
   */
  private static async writeSession(
    session: Omit<SessionCredentials, 'revision'>,
    replaces: string | undefined,
  ): Promise<SessionCredentials> {
    const record = toSessionRecord({ ...session, revision: randomUUID() });
    const secrets: SessionSecrets = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      keyPassword: session.keyPassword,
    };
    try {
      await pRetry(
        () => secretStoreOf(record).save(record.uid, { revision: record.revision, previous: replaces, secrets }),
        STORE_SAVE_RETRY,
      );
    } catch (error) {
      throw credentialsUnavailableError(record, `The session could not be saved to ${record.credentialStore}`, error, 'Fix the credential store');
    }
    await writePrivateJsonFile(SESSION_FILE, record);
    this.loaded = { uid: record.uid, revision: record.revision, secrets };
    return { ...record, ...secrets };
  }

  /**
   * Read session.json and classify it. A file that cannot be parsed or lacks
   * a field of {@link isSessionRecord} is `invalid`.
   */
  static async readStoredSession(sessionFile: string = SESSION_FILE): Promise<StoredSession> {
    if (!await fs.pathExists(sessionFile)) {
      return { kind: 'none' };
    }
    try {
      const record: unknown = await fs.readJson(sessionFile);
      return isSessionRecord(record) ? { kind: 'valid', record: toSessionRecord(record) } : { kind: 'invalid' };
    } catch (error) {
      logger.debug(`Session file unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return { kind: 'invalid' };
    }
  }

  /**
   * The saved session with its secrets, or null when session.json holds no
   * valid session. The secrets are read from the credential store once per
   * revision and process.
   *
   * @throws AppError CREDENTIALS_UNAVAILABLE when the credential store does not return them
   */
  static async loadSession(): Promise<SessionCredentials | null> {
    const stored = await this.readStoredSession();
    if (stored.kind === 'invalid') {
      logger.warn('Session file is not a proton-drive-cli login session. Run: proton-drive-cli login');
    }
    if (stored.kind !== 'valid') {
      return null;
    }
    const secrets = await this.secretsOf(stored.record);
    return { ...stored.record, ...secrets };
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
        if (endedUid !== undefined && stored.kind === 'valid' && stored.record.uid !== endedUid) {
          return false;
        }
        await this.removeSessionFiles();
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
        await this.removeSessionFiles();
        return true;
      });
    } catch (error) {
      throw new Error(`Failed to clear session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Delete session.json and the crypto cache and forget the loaded secrets; called under the session lock. */
  private static async removeSessionFiles(): Promise<void> {
    await fs.remove(SESSION_FILE);
    await this.clearCryptoCache();
    this.loaded = null;
  }

  /**
   * Check if a saved session exists whose access token has not expired locally.
   */
  static async hasValidSession(): Promise<boolean> {
    const stored = await this.readStoredSession();
    if (stored.kind !== 'valid') return false;

    if (isAccessTokenExpired(stored.record)) {
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
   * Runs under the session lock on the session as it is at that moment. When
   * `stale` names another UID, session.json holds a new login and nothing is
   * refreshed. When session.json holds another revision than the one `stale`
   * was loaded from, or the stored access token differs from
   * `stale.accessToken`, another process already refreshed and that session
   * is returned without spending the refresh token (official
   * ApiClient.refreshSessionIfPossible); in the first case its secrets are
   * read after the lock is released. The new tokens are written
   * only while session.json still holds the revision whose refresh token was
   * spent, so a logout or a sign-out during the request is never undone; that
   * check also holds when the lock was reported lost.
   *
   * A refresh the API rejects (see {@link isRefreshRejection}), or answers
   * with another UID, while session.json still holds that revision signs the
   * session out like the official SessionCredentials.signOut: session.json,
   * crypto cache and credential-store entry are removed and SESSION_EXPIRED
   * is thrown. A lost lock keeps the session instead.
   *
   * @param stale - UID and access token the caller observed or had rejected
   * @returns Updated session with new tokens
   */
  static async refreshSession(stale?: SessionTokens, appVersion?: string): Promise<SessionCredentials> {
    type Outcome =
      | { kind: 'session'; session: SessionCredentials }
      | { kind: 'rotated'; stale: SessionTokens }
      | { kind: 'signed-out'; session: SessionCredentials; cause: unknown; reason: string };
    const outcome = await this.withSessionLock(async (held): Promise<Outcome> => {
      const stored = await this.readStoredSession();
      if (stored.kind !== 'valid') {
        throw new AppError('No session to refresh. Run: proton-drive-cli login', ErrorCode.SESSION_EXPIRED, {}, false);
      }
      const { record } = stored;
      if (stale !== undefined && record.uid !== stale.uid) {
        throw sessionReplacedError();
      }
      const staleRevision = stale === undefined ? undefined : this.revisionOf(stale);
      if (stale !== undefined && staleRevision !== undefined && record.revision !== staleRevision && !isAccessTokenExpired(record)) {
        return { kind: 'rotated', stale };
      }
      const session = await this.verifiedSession(record);
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

      const removedError = new AppError(
        'The session was removed during the refresh. Run: proton-drive-cli login',
        ErrorCode.SESSION_EXPIRED,
        {},
        false,
      );
      const current = await this.readStoredSession();
      if (current.kind !== 'valid') {
        throw removedError;
      }
      if (current.record.revision !== session.revision) {
        if (current.record.uid !== session.uid) {
          throw sessionReplacedError();
        }
        logger.info('Session was rotated by another process during the refresh');
        return { kind: 'session', session: await this.verifiedSession(current.record) };
      }

      let updatedSession: SessionCredentials;
      try {
        updatedSession = await this.writeSession({
          ...session,
          accessToken: result.AccessToken,
          refreshToken: result.RefreshToken,
          tokenExpiresAt: resolveTokenExpiresAt(result.ExpiresIn),
        }, session.revision);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== ErrorCode.CREDENTIALS_UNAVAILABLE) {
          throw error;
        }
        const storeError = typeof error.details?.storeError === 'string' ? error.details.storeError : error.message;
        throw new AppError(
          `The refreshed tokens could not be saved to ${session.credentialStore} (${storeError}); the refresh token it held is spent. Fix the credential store; if the next command fails, run: proton-drive-cli login`,
          ErrorCode.CREDENTIALS_UNAVAILABLE,
          { credentialStore: session.credentialStore, credentialHost: session.credentialHost, storeError },
          false,
        );
      }
      logger.info('Token refreshed successfully');
      return { kind: 'session', session: updatedSession };
    });

    if (outcome.kind === 'session') {
      return outcome.session;
    }
    if (outcome.kind === 'rotated') {
      const rotated = await this.loadSession();
      if (!rotated || rotated.uid !== outcome.stale.uid) {
        throw sessionReplacedError();
      }
      if (rotated.accessToken === outcome.stale.accessToken) {
        return this.refreshSession({ ...outcome.stale, revision: rotated.revision }, appVersion);
      }
      logger.info('Session was already refreshed by another process');
      return rotated;
    }
    const credentialsRemoved = await this.removeSecrets(outcome.session);
    throw signedOutError(outcome.cause, outcome.reason, credentialsRemoved);
  }

  /**
   * Under the session lock: delete session.json and the crypto cache when the
   * file still holds the revision of `session` and the lock was not reported
   * lost; true when it did.
   */
  private static async signOutIfUnchanged(session: SessionRecord, held: HeldSessionLock): Promise<boolean> {
    if (held.compromised) {
      return false;
    }
    const current = await this.readStoredSession();
    if (current.kind !== 'valid' || current.record.revision !== session.revision) {
      return false;
    }
    logger.warn('Signing out the session after a rejected refresh');
    await this.removeSessionFiles();
    return true;
  }

  /** Remove the credential-store entry of `session`; false, with the failure logged, when that fails. */
  static async removeSecrets(session: SessionRecord): Promise<boolean> {
    try {
      await secretStoreOf(session).remove(session.uid);
      return true;
    } catch (error) {
      logger.warn(`Could not remove the credentials of session ${uidFingerprint(session.uid)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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
      const latest = await this.loadSession().catch(() => null);
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
  static async validateSession(session: Pick<SessionRecord, 'tokenExpiresAt'>): Promise<boolean> {
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

      const stored = await this.readStoredSession();
      if (stored.kind !== 'valid' || stored.record.uid !== cache.sessionUid) {
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
        if (stored.kind !== 'valid' || stored.record.uid !== sessionUid) {
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
