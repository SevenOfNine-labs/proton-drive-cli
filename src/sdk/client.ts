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
import { logger } from '../utils/logger';

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
): Promise<ProtonDriveClient> {
  const driveCrypto = new DriveCryptoService();

  let sessionReady = false;

  // Step 1: Try existing session
  try {
    if (await SessionManager.hasValidSession()) {
      // Access token is still valid — use it directly
      sessionReady = true;
      logger.debug('SDK client: valid session found');
    } else {
      // Session may exist but token is expired — try proactive refresh
      const session = await SessionManager.loadSession();
      if (session) {
        logger.debug('SDK client: session expired, attempting proactive refresh');
        const { AuthApiClient } = await import('../api/auth');
        const authApi = new AuthApiClient();
        const refreshResult = await authApi.refreshToken(session.uid, session.refreshToken);
        await SessionManager.saveSession({
          ...session,
          accessToken: refreshResult.AccessToken,
          refreshToken: refreshResult.RefreshToken,
        });
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
        logger.debug('SDK client: session refreshed by another process');
      }
    } catch {
      // Still no valid session — fall through to full login
    }
  }

  // Step 2: Initialize crypto with the session, or fall back to full login
  if (sessionReady) {
    try {
      await driveCrypto.initialize(password);
      logger.debug('SDK client: crypto initialized from session');
    } catch (cryptoErr) {
      // Crypto init failed (API error during key fetch, bad password, etc.)
      // Fall through to full login only if we have credentials
      logger.debug(`SDK client: crypto init failed (${cryptoErr instanceof Error ? cryptoErr.message : cryptoErr}), will try full login`);
      sessionReady = false;
    }
  }

  if (!sessionReady) {
    if (!username || !password) {
      throw new Error('No session found and credentials not provided');
    }
    const authService = new AuthService();
    await authService.login(username, password);
    await driveCrypto.initialize(password);
    logger.debug('SDK client: authenticated with full SRP login');
  }

  // Build adapters
  const cryptoProxy = new ProtonOpenPGPCryptoProxy();
  const openPGPCrypto = new OpenPGPCryptoWithCryptoProxy(cryptoProxy);
  const httpClient = new HTTPClientAdapter();
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
