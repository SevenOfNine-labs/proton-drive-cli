import { AuthApiClient } from '../api/auth';
import { SessionManager } from './session';
import { createKeyPasswordStore } from './key-password-store';
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
      throw new Error('No valid session found. Please login first using browser sign-in: proton-drive login');
    }

    if (this.isTokenExpiringSoon(existingSession.accessToken)) {
      return await this.refreshSession();
    }

    return existingSession;
  }

  /**
   * Check if a JWT token is expiring soon (within 5 minutes).
   */
  private isTokenExpiringSoon(token: string): boolean {
    try {
      const { exp } = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as { exp?: number };
      if (!exp) return false;
      const now = Math.floor(Date.now() / 1000);
      return (exp - now) < 5 * 60;
    } catch {
      return false;
    }
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
   */
  async logout(): Promise<void> {
    try {
      const session = await SessionManager.loadSession();
      if (session) {
        try {
          await this.authApi.logout(session.accessToken);
        } catch {
          logger.warn('Could not revoke session on server (this is normal if token is expired)');
        }

        if (session.authMode === 'browser-fork' && session.keyPasswordPersisted) {
          const keyPasswordStore = createKeyPasswordStore({
            provider: session.keyPasswordProvider,
            host: session.keyPasswordHost,
          });
          await keyPasswordStore.remove(session.uid).catch((error) => {
            logger.warn(`Could not remove browser-fork key password: ${error instanceof Error ? error.message : error}`);
          });
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
