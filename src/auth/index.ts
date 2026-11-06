import { AuthApiClient } from '../api/auth';
import { SessionManager } from './session';
import { createKeyPasswordStore } from './key-password-store';
import { isAccessTokenExpiringSoon } from './token-expiry';
import { SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';

/**
 * Session lifecycle service.
 *
 * Browser-fork login is implemented by BrowserForkAuthService. This service is
 * intentionally limited to existing-session operations so production code
 * cannot create Proton account sessions from username/password credentials.
 */
export class AuthService {
  private authApi: AuthApiClient;

  constructor(apiBaseUrl?: string, private readonly appVersion?: string) {
    this.authApi = new AuthApiClient(apiBaseUrl, appVersion);
  }

  /**
   * Get current session or throw error if not authenticated.
   */
  async getSession(): Promise<SessionCredentials> {
    const existingSession = await SessionManager.loadSession();
    if (!existingSession) {
      throw new Error('No valid session found. Please login first using browser sign-in: proton-drive-cli login');
    }

    if (isAccessTokenExpiringSoon(existingSession)) {
      return await this.refreshSession();
    }

    return existingSession;
  }

  /**
   * Check if user is currently authenticated.
   */
  async isAuthenticated(): Promise<boolean> {
    return await SessionManager.hasValidSession();
  }

  /**
   * Refresh the access token using the refresh token.
   */
  async refreshSession(): Promise<SessionCredentials> {
    try {
      const updatedSession = await SessionManager.refreshSession(undefined, this.appVersion);
      logger.info('Access token refreshed');
      return updatedSession;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Token refresh failed: ${error.message}`);
      }
      throw new Error('Token refresh failed: Unknown error');
    }
  }

  /**
   * Logout and clear the current session.
   *
   * Order matters: the key-password entry is removed first, while
   * session.json still names its provider and host; then the server session
   * is revoked; then the local session and crypto cache are deleted. A
   * failed revocation (network, token already invalid) is logged and local
   * cleanup still completes, so a logout never leaves tokens on disk.
   */
  async logout(): Promise<void> {
    try {
      const session = await SessionManager.loadSession();
      if (session) {
        if (session.authMode === 'browser-fork' && session.keyPasswordPersisted) {
          const keyPasswordStore = createKeyPasswordStore({
            provider: session.keyPasswordProvider,
            host: session.keyPasswordHost,
          });
          await keyPasswordStore.remove(session.uid).catch((error) => {
            logger.warn(`Could not remove browser-fork key password: ${error instanceof Error ? error.message : error}`);
          });
        }

        try {
          await this.authApi.logout(session.uid, session.accessToken);
        } catch (error) {
          logger.warn(`Could not revoke session on server: ${error instanceof Error ? error.message : error}`);
        }
      }

      await SessionManager.clearSession();
      await SessionManager.clearCryptoCache();
      logger.info('Logged out successfully');
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Logout failed: ${error.message}`);
      }
      throw new Error('Logout failed: Unknown error');
    }
  }
}

export { SessionManager };
