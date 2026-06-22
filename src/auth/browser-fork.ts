import { createDecipheriv, randomBytes } from 'crypto';
import { jwtDecode } from 'jwt-decode';
import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { getProtonAppVersion } from '../constants';
import { AppError, ErrorCode } from '../errors/types';
import { SessionForkStatusResponse, SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';
import {
  createKeyPasswordStore,
  KeyPasswordProviderName,
  KeyPasswordStore,
  normalizeKeyPasswordProvider,
} from './key-password-store';
import { SessionManager } from './session';

export const PROTON_ACCOUNT_URL = 'https://account.proton.me';
export const DEFAULT_BROWSER_FORK_AUTH_CLIENT_ID = 'external-drive';
export const BROWSER_FORK_INITIAL_DELAY_MS = 5_000;
export const BROWSER_FORK_POLL_INTERVAL_MS = 5_000;
export const BROWSER_FORK_MAX_POLL_TIME_MS = 10 * 60 * 1_000;

const FORK_AAD = Buffer.from('fork', 'utf8');

type BrowserForkAuthApi = Pick<AuthApiClient, 'initSessionFork' | 'getSessionForkStatus'>;
type SleepFn = (ms: number) => Promise<void>;

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
  return getProtonAppVersion(appVersion).startsWith('cli-drive')
    ? 'cli-drive'
    : DEFAULT_BROWSER_FORK_AUTH_CLIENT_ID;
}

function resolveTokenExpiresAt(accessToken: string, expiresIn?: number): number | undefined {
  if (expiresIn && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }

  try {
    const decoded = jwtDecode<{ exp?: number }>(accessToken);
    return decoded.exp ? decoded.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
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
  private readonly keyPasswordProvider: KeyPasswordProviderName;
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
      if (this.now() - startedAt > maxPollTimeMs) {
        throw new AppError(
          'Browser authentication timed out',
          ErrorCode.TIMEOUT,
          { authMode: 'browser-fork', maxPollTimeMs },
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
        { authMode: 'browser-fork' },
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
        { authMode: 'browser-fork' },
        true
      );
    }

    const keyPasswordStore = this.keyPasswordStore ?? createKeyPasswordStore({
      provider: this.keyPasswordProvider,
      host: this.keyPasswordHost,
    });
    await this.persistKeyPassword(keyPasswordStore, status.UID, userKeyPassword);

    const session: SessionCredentials = {
      sessionId: status.UID,
      uid: status.UID,
      accessToken: status.AccessToken,
      refreshToken: status.RefreshToken,
      scopes: status.Scopes ?? [],
      passwordMode: status.PasswordMode ?? 2,
      authMode: 'browser-fork',
      keyPasswordPersisted: true,
      keyPasswordProvider: keyPasswordStore.provider,
      keyPasswordHost: keyPasswordStore.host,
      tokenExpiresAt: resolveTokenExpiresAt(status.AccessToken, status.ExpiresIn),
    };

    try {
      await SessionManager.saveSession(session);
    } catch (error) {
      await keyPasswordStore.remove(status.UID).catch(() => {});
      throw error;
    }
    logger.info('Browser fork authentication successful');
    logger.debug(`Session saved (tokens only) to: ${SessionManager.getSessionFilePath()}`);

    return { session, keyPasswordAvailable: true };
  }

  private async persistKeyPassword(
    store: KeyPasswordStore,
    uid: string,
    keyPassword: string
  ): Promise<void> {
    try {
      await store.store(uid, keyPassword);
      if (!await store.verify(uid)) {
        await store.remove(uid).catch(() => {});
        throw new Error('key password readback verification failed');
      }
    } catch (error: unknown) {
      throw new AppError(
        `Could not persist browser fork key password: ${error instanceof Error ? error.message : 'unknown error'}`,
        ErrorCode.AUTH_FAILED,
        {
          authMode: 'browser-fork',
          keyPasswordProvider: store.provider,
          keyPasswordHost: store.host,
        },
        true
      );
    }
  }
}
