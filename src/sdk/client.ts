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
import { toAppError } from '../errors/classify';
import type { SessionCredentials } from '../types/auth';

export interface CreateSDKClientOptions {
  appVersion?: string;
}

async function loadKeyPassword(session: SessionCredentials): Promise<string> {
  const store = createKeyPasswordStore({
    provider: session.keyPasswordProvider,
    host: session.keyPasswordHost,
  });
  try {
    return await store.load(session.uid);
  } catch (error) {
    const providerError = error instanceof Error ? error.message : String(error);
    throw new AppError(
      `The key password of the session could not be read from ${store.provider} (${providerError}). ` +
        'Fix the credential provider, or run: proton-drive-cli login',
      ErrorCode.KEY_PASSWORD_REQUIRED,
      {
        keyPasswordProvider: store.provider,
        keyPasswordHost: store.host,
        providerError,
      },
      true,
    );
  }
}

/**
 * The saved session, refreshed first when its access token expired locally. A
 * refresh failure keeps its code; SESSION_EXPIRED means signed out, removed or replaced.
 */
async function loadUsableSession(appVersion?: string): Promise<SessionCredentials | null> {
  const session = await SessionManager.loadSession();
  if (!session) {
    return null;
  }
  if (await SessionManager.validateSession(session)) {
    logger.debug('SDK client: valid session found');
    return session;
  }

  logger.debug('SDK client: session expired, refreshing');
  try {
    return await SessionManager.refreshSessionOrAdoptRotated(session, appVersion);
  } catch (error) {
    throw toAppError(error);
  }
}

/**
 * Create an authenticated ProtonDriveClient from the saved browser-fork
 * session: a locally expired access token is refreshed first, then the
 * account keys are unlocked with the stored key password. Without a usable
 * session the call fails with SESSION_EXPIRED; it never logs in.
 *
 * @returns Initialized ProtonDriveClient ready for operations
 */
export async function createSDKClient(
  options: CreateSDKClientOptions = {},
): Promise<ProtonDriveClient> {
  const session = await loadUsableSession(options.appVersion);
  if (!session) {
    throw new AppError(
      'No usable browser-fork session. Run: proton-drive-cli login',
      ErrorCode.SESSION_EXPIRED,
      {},
      true,
    );
  }

  const driveCrypto = new DriveCryptoService(options.appVersion);
  await driveCrypto.initialize(await loadKeyPassword(session));
  logger.debug('SDK client: account keys unlocked');

  const cryptoProxy = new ProtonOpenPGPCryptoProxy();
  const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(cryptoProxy);
  const httpClient = new HTTPClientAdapter(options.appVersion);
  const account = new AccountAdapter(driveCrypto);
  const srpModule = new SRPModuleAdapter();

  // The telemetry adapter keeps SDK logs and metrics off stdout (sdk/telemetry.ts).
  return new ProtonDriveClient({
    httpClient,
    entitiesCache: new MemoryCache(),
    cryptoCache: new MemoryCache(),
    account,
    openPGPCryptoModule: openPGPCrypto,
    srpModule,
    telemetry: createSdkTelemetry(),
  });
}
