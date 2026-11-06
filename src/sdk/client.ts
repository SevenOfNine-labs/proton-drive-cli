/**
 * SDK client factory for the Proton Drive SDK.
 *
 * Constructs a ProtonDriveClient with all required adapters:
 * - OpenPGPCryptoProxy → OpenPGPCryptoWithCryptoProxy
 * - HTTPClientAdapter (injects session tokens)
 * - AccountAdapter (wraps DriveCryptoService)
 * - SRPModuleAdapter (SDK-required key derivation adapter; not account login)
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
import { createSdkTelemetry } from './telemetry';
import { DriveCryptoService } from '../crypto/drive-crypto';
import { SessionManager } from '../auth/session';
import { createKeyPasswordStore } from '../auth/key-password-store';
import { logger } from '../utils/logger';
import { AppError, ErrorCode } from '../errors/types';
import type { SessionCredentials } from '../types/auth';

export interface CreateSDKClientOptions {
  dataPassword?: string;
  appVersion?: string;
}

interface NormalizedCreateSDKClientOptions {
  dataPassword?: string;
  dataPasswordExplicit: boolean;
  appVersion?: string;
}

function normalizeCreateSDKClientOptions(
  options: CreateSDKClientOptions,
): NormalizedCreateSDKClientOptions {
  return {
    dataPassword: options.dataPassword,
    dataPasswordExplicit: Boolean(options.dataPassword),
    appVersion: options.appVersion,
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
 * Session strategy (in order):
 * 1. Valid session (not expired) → use directly, initialize crypto
 * 2. Expired session with refresh token → proactive refresh, then crypto
 * 3. No session or refresh failed → fail closed; run browser login first
 *
 * Crypto initialization is expensive (3 API calls: keySalts, user, addresses).
 * When a crypto cache exists on disk, those calls are skipped entirely.
 *
 * @param clientOptions - Optional explicit mailbox/data password for crypto unlock and app version
 * @returns Initialized ProtonDriveClient ready for operations
 */
export async function createSDKClient(
  clientOptions: CreateSDKClientOptions = {},
): Promise<ProtonDriveClient> {
  const options = normalizeCreateSDKClientOptions(clientOptions);
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
      // Still no valid session — fail closed below.
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
    throw new AppError(
      'No browser-fork session found. Run proton-drive-cli login before transfers.',
      ErrorCode.SESSION_EXPIRED,
      { authMode: 'browser-fork' },
      true,
    );
  }

  // Build adapters
  const cryptoProxy = new ProtonOpenPGPCryptoProxy();
  const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(cryptoProxy);
  const httpClient = new HTTPClientAdapter(options.appVersion);
  const account = new AccountAdapter(driveCrypto);
  const srpModule = new SRPModuleAdapter();

  // Construct ProtonDriveClient with all required adapters. The telemetry
  // adapter keeps SDK logs and metrics off stdout (see sdk/telemetry.ts).
  const client = new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: openPGPCrypto,
    srpModule,
    telemetry: createSdkTelemetry(),
  });

  return client;
}
