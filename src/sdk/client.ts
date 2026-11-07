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
import { logger } from '../utils/logger';
import { AppError, ErrorCode } from '../errors/types';
import { toAppError } from '../errors/classify';
import type { SessionCredentials } from '../types/auth';

export interface CreateSDKClientOptions {
  appVersion?: string;
}

/**
 * The saved session with its secrets, refreshed first when its access token
 * expired locally. A refresh failure keeps its code; SESSION_EXPIRED means
 * signed out, removed or replaced, CREDENTIALS_UNAVAILABLE an unreadable store.
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
 * account keys are unlocked with the key password of its credential-store
 * entry. Without a usable session the call fails with SESSION_EXPIRED; it
 * never logs in.
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
  await driveCrypto.initialize(session.keyPassword);
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
