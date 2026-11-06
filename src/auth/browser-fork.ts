import { createDecipheriv, randomBytes } from 'crypto';
import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { getProtonAppVersion } from '../constants';
import { AppError, ErrorCode } from '../errors/types';
import { SessionForkStatusResponse, SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';
import { uidFingerprint } from '../utils/redaction';
import type { ProviderName } from '../credentials/types';
import {
  createKeyPasswordStore,
  KeyPasswordStore,
  normalizeKeyPasswordProvider,
} from './key-password-store';
import { SessionManager } from './session';
import { resolveTokenExpiresAt } from './token-expiry';

export const PROTON_ACCOUNT_URL = 'https://account.proton.me';
export const DEFAULT_BROWSER_FORK_AUTH_CLIENT_ID = 'external-drive';
/**
 * Session-fork polling schedule of the official account module
 * (incubating/account/js/src/authWeb.ts FORK_INITIAL_DELAY_MS,
 * FORK_POLL_INTERVAL_MS, FORK_MAX_POLL_TIME_MS): a first status request
 * after the initial delay, then one per interval while the API answers 422.
 */
export const BROWSER_FORK_INITIAL_DELAY_MS = 5_000;
export const BROWSER_FORK_POLL_INTERVAL_MS = 5_000;
export const BROWSER_FORK_MAX_POLL_TIME_MS = 10 * 60 * 1_000;

const FORK_AAD = Buffer.from('fork', 'utf8');

export type BrowserForkAuthApi = Pick<AuthApiClient, 'initSessionFork' | 'getSessionForkStatus' | 'logout' | 'refreshToken'>;
export type SleepFn = (ms: number) => Promise<void>;

export interface BrowserForkSignInUrl {
  encryptionKey: Buffer;
  signInUrl: string;
}

export interface BrowserForkAuthServiceOptions {
  apiBaseUrl?: string;
  appVersion?: string;
  authApi?: BrowserForkAuthApi;
  keyPasswordProvider?: string;
  keyPasswordHost?: string;
  keyPasswordStore?: KeyPasswordStore;
  sleepMs?: SleepFn;
  now?: () => number;
  encryptionKeyFactory?: () => Buffer;
}

export interface BrowserForkLoginOptions {
  authClientId?: string;
  initialDelayMs?: number;
  pollIntervalMs?: number;
  maxPollTimeMs?: number;
  onSignInUrl?: (signInUrl: string) => void | Promise<void>;
}

export interface BrowserForkLoginResult {
  session: SessionCredentials;
  keyPasswordAvailable: true;
}

function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAuthClientId(appVersion?: string): string {
  // Fail fast on an invalid app-version identity before any network call.
  // Third-party builds always fork sessions as `external-drive`; the official
  // `cli-drive` identity is reserved for Proton's own CLI.
  getProtonAppVersion(appVersion);
  return DEFAULT_BROWSER_FORK_AUTH_CLIENT_ID;
}

function isPendingForkStatus(error: unknown): boolean {
  return isHttpClientError(error) && error.response?.status === 422;
}

export function generateBrowserForkSignInUrl(
  authClientId: string,
  userCode: string,
  encryptionKey: Buffer = randomBytes(32)
): BrowserForkSignInUrl {
  if (encryptionKey.length !== 32) {
    throw new Error('Browser fork encryption key must be 32 bytes');
  }

  const base64EncodedKey = encryptionKey.toString('base64');
  const payload = `0:${userCode}:${base64EncodedKey}:${authClientId}`;
  const signInUrl = `${PROTON_ACCOUNT_URL}/desktop/login?app=drive&pv=3#payload=${encodeURIComponent(payload)}`;

  return { encryptionKey, signInUrl };
}

export function parseBrowserForkUserKeyPassword(
  encryptionKey: Buffer,
  encryptedPayload: string
): string {
  if (encryptionKey.length !== 32) {
    throw new Error('Browser fork encryption key must be 32 bytes');
  }

  const data = Buffer.from(encryptedPayload, 'base64');
  if (data.length <= 28) {
    throw new Error('Browser fork payload is too short');
  }

  const nonce = data.subarray(0, 12);
  const cipherText = data.subarray(12, -16);
  const tag = data.subarray(-16);

  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, nonce);
  decipher.setAAD(FORK_AAD);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(decrypted) as { keyPassword?: unknown };

  if (typeof parsed.keyPassword !== 'string' || !parsed.keyPassword) {
    throw new Error('Browser fork payload is missing keyPassword');
  }

  return parsed.keyPassword;
}

export class BrowserForkAuthService {
  private readonly authApi: BrowserForkAuthApi;
  private readonly appVersion?: string;
  private readonly keyPasswordProvider: ProviderName;
  private readonly keyPasswordHost?: string;
  private readonly keyPasswordStore?: KeyPasswordStore;
  private readonly sleepMs: SleepFn;
  private readonly now: () => number;
  private readonly encryptionKeyFactory: () => Buffer;

  constructor(options: BrowserForkAuthServiceOptions = {}) {
    this.appVersion = options.appVersion;
    this.authApi = options.authApi ?? new AuthApiClient(options.apiBaseUrl, options.appVersion);
    this.keyPasswordProvider = normalizeKeyPasswordProvider(options.keyPasswordProvider);
    this.keyPasswordHost = options.keyPasswordHost;
    this.keyPasswordStore = options.keyPasswordStore;
    this.sleepMs = options.sleepMs ?? defaultSleepMs;
    this.now = options.now ?? Date.now;
    this.encryptionKeyFactory = options.encryptionKeyFactory ?? (() => randomBytes(32));
  }

  async login(options: BrowserForkLoginOptions = {}): Promise<BrowserForkLoginResult> {
    const fork = await this.authApi.initSessionFork();
    const authClientId = options.authClientId ?? resolveAuthClientId(this.appVersion);
    const { encryptionKey, signInUrl } = generateBrowserForkSignInUrl(
      authClientId,
      fork.UserCode,
      this.encryptionKeyFactory()
    );

    await options.onSignInUrl?.(signInUrl);
    await this.sleepMs(options.initialDelayMs ?? BROWSER_FORK_INITIAL_DELAY_MS);

    const startedAt = this.now();
    const maxPollTimeMs = options.maxPollTimeMs ?? BROWSER_FORK_MAX_POLL_TIME_MS;
    const pollIntervalMs = options.pollIntervalMs ?? BROWSER_FORK_POLL_INTERVAL_MS;

    while (true) {
      const elapsedMs = this.now() - startedAt;
      if (elapsedMs > maxPollTimeMs) {
        throw new AppError(
          'Browser authentication timed out',
          ErrorCode.TIMEOUT,
          { maxPollTimeMs },
          true
        );
      }

      try {
        const status = await this.authApi.getSessionForkStatus(fork.Selector);
        return await this.completeLogin(status, encryptionKey);
      } catch (error: unknown) {
        if (isPendingForkStatus(error)) {
          logger.debug('Browser fork authentication not ready yet');
          await this.sleepMs(pollIntervalMs);
          continue;
        }
        throw error;
      }
    }
  }

  private async completeLogin(
    status: SessionForkStatusResponse,
    encryptionKey: Buffer
  ): Promise<BrowserForkLoginResult> {
    if (!status.RefreshToken) {
      throw new AppError(
        'Browser fork did not return a refresh token; refusing to persist a partial session',
        ErrorCode.AUTH_FAILED,
        {},
        true
      );
    }

    let userKeyPassword: string;
    try {
      userKeyPassword = parseBrowserForkUserKeyPassword(encryptionKey, status.Payload);
    } catch (error: unknown) {
      throw new AppError(
        `Browser fork payload could not be decrypted: ${error instanceof Error ? error.message : 'unknown error'}`,
        ErrorCode.AUTH_FAILED,
        {},
        true
      );
    }

    const keyPasswordStore = this.keyPasswordStore ?? createKeyPasswordStore({
      provider: this.keyPasswordProvider,
      host: this.keyPasswordHost,
    });
    const forked = {
      uid: status.UID,
      accessToken: status.AccessToken,
      refreshToken: status.RefreshToken,
    };
    try {
      await this.persistKeyPassword(keyPasswordStore, status.UID, userKeyPassword);
    } catch (error) {
      await this.revokeBestEffort(forked);
      throw error;
    }

    const session: SessionCredentials = {
      uid: status.UID,
      accessToken: status.AccessToken,
      refreshToken: status.RefreshToken,
      scopes: status.Scopes ?? [],
      keyPasswordProvider: keyPasswordStore.provider,
      keyPasswordHost: keyPasswordStore.host,
      tokenExpiresAt: resolveTokenExpiresAt(status.ExpiresIn),
    };

    let previous: SessionCredentials | null;
    try {
      previous = await SessionManager.replaceSession(session);
    } catch (error) {
      await keyPasswordStore.remove(status.UID).catch(() => {});
      await this.revokeBestEffort(forked);
      throw error;
    }
    logger.info('Browser fork authentication successful');
    logger.debug(`Session saved (tokens only) to: ${SessionManager.getSessionFilePath()}`);

    if (previous && previous.uid !== session.uid) {
      await SessionManager.removeKeyPassword(previous);
      await this.revokeBestEffort(previous);
    }

    return { session, keyPasswordAvailable: true };
  }

  /**
   * End a session this login discards: DELETE /auth/v4, after one refresh
   * when the access token is rejected (HTTP 401). Failures are logged.
   */
  private async revokeBestEffort(session: Pick<SessionCredentials, 'uid' | 'accessToken' | 'refreshToken'>): Promise<void> {
    try {
      await this.authApi.logout(session.uid, session.accessToken);
    } catch (error) {
      try {
        if (!isHttpClientError(error) || error.response?.status !== 401) {
          throw error;
        }
        const refreshed = await this.authApi.refreshToken(session.uid, session.accessToken, session.refreshToken);
        await this.authApi.logout(refreshed.UID, refreshed.AccessToken);
      } catch (revokeError) {
        logger.warn(`Could not revoke the discarded session ${uidFingerprint(session.uid)}: ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`);
      }
    }
  }

  private async persistKeyPassword(
    store: KeyPasswordStore,
    uid: string,
    keyPassword: string
  ): Promise<void> {
    try {
      await store.store(uid, keyPassword);
      if (await store.load(uid).catch(() => undefined) !== keyPassword) {
        await store.remove(uid).catch(() => {});
        throw new Error('key password readback verification failed');
      }
    } catch (error: unknown) {
      throw new AppError(
        `Could not persist browser fork key password: ${error instanceof Error ? error.message : 'unknown error'}`,
        ErrorCode.AUTH_FAILED,
        {
          keyPasswordProvider: store.provider,
          keyPasswordHost: store.host,
        },
        true
      );
    }
  }
}
