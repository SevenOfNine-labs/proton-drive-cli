/**
 * SDK client factory for the Proton Drive SDK.
 *
 * Constructs a ProtonDriveClient with all required adapters:
 * - OpenPGPCryptoProxy → OpenPGPCryptoWithCryptoProxy
 * - HTTPClientAdapter (injects session tokens)
 * - AccountAdapter (wraps DriveCryptoService)
 * - SRPModuleAdapter (wraps SRP + key derivation)
 * - MemoryCache × 2 (entities + crypto)
 */

import {
  ProtonDriveClient,
  MemoryCache,
  OpenPGPCryptoWithCryptoProxy,
} from '@protontech/drive-sdk';
import { ProtonOpenPGPCryptoProxy } from './cryptoProxy';
import { HTTPClientAdapter } from './httpClientAdapter';
import { AccountAdapter } from './accountAdapter';
import { SRPModuleAdapter } from './srpAdapter';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { AuthService } from '../auth';
import { SessionManager } from '../auth/session';
import { createKeyPasswordStore } from '../auth/key-password-store';
import { logger } from '../utils/logger';
import { AppError, ErrorCode } from '../errors/types';
import type { SessionCredentials } from '../types/auth';

export interface CreateSDKClientOptions {
  username?: string;
  loginPassword?: string;
  dataPassword?: string;
  secondFactorCode?: string;
  allowLogin?: boolean;
  appVersion?: string;
}

interface NormalizedCreateSDKClientOptions {
  username?: string;
  loginPassword?: string;
  dataPassword?: string;
  dataPasswordExplicit: boolean;
  secondFactorCode?: string;
  allowLogin: boolean;
  appVersion?: string;
}

function normalizeCreateSDKClientOptions(
  passwordOrOptions: string | CreateSDKClientOptions,
  username?: string,
): NormalizedCreateSDKClientOptions {
  if (typeof passwordOrOptions === 'string') {
    return {
      username,
      loginPassword: username ? passwordOrOptions : undefined,
      dataPassword: passwordOrOptions,
      // Legacy createSDKClient(password) means "password for key decryption".
      // Legacy createSDKClient(password, username) means "login password";
      // two-password accounts must move to the options form with dataPassword.
      dataPasswordExplicit: !username,
      allowLogin: Boolean(username && passwordOrOptions),
      appVersion: undefined,
    };
  }

  return {
    username: passwordOrOptions.username,
    loginPassword: passwordOrOptions.loginPassword,
    dataPassword: passwordOrOptions.dataPassword ?? passwordOrOptions.loginPassword,
    dataPasswordExplicit: Boolean(passwordOrOptions.dataPassword),
    secondFactorCode: passwordOrOptions.secondFactorCode,
    allowLogin: passwordOrOptions.allowLogin ?? Boolean(passwordOrOptions.username && passwordOrOptions.loginPassword),
    appVersion: passwordOrOptions.appVersion,
  };
}

function getKeyUnlockPassword(
  options: NormalizedCreateSDKClientOptions,
  passwordMode?: number,
): string {
  if (passwordMode === 2 && !options.dataPasswordExplicit) {
    throw new AppError(
      'Mailbox/data password required for this two-password Proton account',
      ErrorCode.DATA_PASSWORD_REQUIRED,
      { passwordMode },
      true,
    );
  }

  const password = options.dataPassword;
  if (!password) {
    throw new AppError(
      'Password required for key decryption',
      ErrorCode.AUTH_FAILED,
      undefined,
      true,
    );
  }

  return password;
}

async function getStoredBrowserForkKeyPassword(session: SessionCredentials): Promise<string> {
  const store = createKeyPasswordStore({
    provider: session.keyPasswordProvider,
    host: session.keyPasswordHost,
  });
  const keyPassword = await store.load(session.uid);
  if (!keyPassword) {
    throw new AppError(
      'Stored browser-fork key password is missing or unreadable',
      ErrorCode.KEY_PASSWORD_REQUIRED,
      {
        authMode: session.authMode,
        keyPasswordProvider: store.provider,
        keyPasswordHost: store.host,
      },
      true,
    );
  }
  return keyPassword;
}

async function initializeCryptoForSession(
  driveCrypto: DriveCryptoService,
  options: NormalizedCreateSDKClientOptions,
  session: SessionCredentials | null,
): Promise<void> {
  if (session?.authMode === 'browser-fork' && session.keyPasswordPersisted && !options.dataPasswordExplicit) {
    const keyPassword = await getStoredBrowserForkKeyPassword(session);
    await driveCrypto.initializeWithUserKeyPassword(keyPassword);
    return;
  }

  await driveCrypto.initialize(getKeyUnlockPassword(options, session?.passwordMode));
}

/**
 * Create an authenticated ProtonDriveClient with all adapters.
 *
 * Authentication strategy (in order):
 * 1. Valid session (not expired) → use directly, initialize crypto
 * 2. Expired session with refresh token → proactive refresh, then crypto
 * 3. No session or refresh failed → full SRP login
 *
 * Crypto initialization is expensive (3 API calls: keySalts, user, addresses).
 * When a crypto cache exists on disk, those calls are skipped entirely.
 *
 * @param password - User's mailbox password (always required for crypto)
 * @param username - Required for full login (optional if restoring session)
 * @returns Initialized ProtonDriveClient ready for operations
 */
export async function createSDKClient(
  password: string,
  username?: string,
): Promise<ProtonDriveClient>;
export async function createSDKClient(
  options: CreateSDKClientOptions,
): Promise<ProtonDriveClient>;
export async function createSDKClient(
  passwordOrOptions: string | CreateSDKClientOptions,
  username?: string,
): Promise<ProtonDriveClient> {
  const options = normalizeCreateSDKClientOptions(passwordOrOptions, username);
  const driveCrypto = new DriveCryptoService(options.appVersion);

  let sessionReady = false;
  let session = await SessionManager.loadSession();

  // Step 1: Try existing session
  try {
    if (await SessionManager.hasValidSession()) {
      // Access token is still valid — use it directly
      sessionReady = true;
      session = await SessionManager.loadSession();
      logger.debug('SDK client: valid session found');
    } else {
      // Session may exist but token is expired — try proactive refresh
      if (session) {
        logger.debug('SDK client: session expired, attempting proactive refresh');
        session = await SessionManager.refreshSession(session, options.appVersion);
        sessionReady = true;
        logger.debug('SDK client: proactive token refresh succeeded');
      }
    }
  } catch (refreshErr) {
    // Refresh failed (token consumed by another process, or network error).
    // Try re-reading session — another process may have already refreshed.
    try {
      if (await SessionManager.hasValidSession()) {
        sessionReady = true;
        session = await SessionManager.loadSession();
        logger.debug('SDK client: session refreshed by another process');
      }
    } catch {
      // Still no valid session — fall through to full login
    }
  }

  // Step 2: Initialize crypto with an existing session. If key unlock fails,
  // stop here; do not convert a bad data password into another SRP login.
  if (sessionReady) {
    try {
      await initializeCryptoForSession(driveCrypto, options, session);
      logger.debug('SDK client: crypto initialized from session');
    } catch (cryptoErr) {
      logger.warn(`SDK client: crypto init failed (${cryptoErr instanceof Error ? cryptoErr.message : cryptoErr}); refusing automatic re-login`);
      throw cryptoErr;
    }
  }

  if (!sessionReady) {
    if (!options.allowLogin || !options.username || !options.loginPassword) {
      throw new Error('No session found and credentials not provided');
    }
    const authService = new AuthService(undefined, options.appVersion);
    const loginSession = await authService.login(options.username, options.loginPassword, {
      secondFactorCode: options.secondFactorCode,
    });
    await driveCrypto.initialize(getKeyUnlockPassword(options, loginSession.passwordMode));
    logger.debug('SDK client: authenticated with full SRP login');
  }

  // Build adapters
  const cryptoProxy = new ProtonOpenPGPCryptoProxy();
  const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(cryptoProxy);
  const httpClient = new HTTPClientAdapter(options.appVersion);
  const account = new AccountAdapter(driveCrypto);
  const srpModule = new SRPModuleAdapter();

  // Construct ProtonDriveClient with all required adapters
  const client = new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: openPGPCrypto,
    srpModule,
  });

  return client;
}
