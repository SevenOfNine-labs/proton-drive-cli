import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { AppError } from '../errors/types';
import { SessionManager } from './session';
import { SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';

/** Outcome of DELETE /auth/v4 for a session being logged out. */
type Revocation = 'revoked' | 'signed-out' | 'failed';

/**
 * Lifecycle of an existing session: read, refresh, logout. Sessions are
 * created only by BrowserForkAuthService (`proton-drive-cli login`).
 */
export class AuthService {
  private authApi: AuthApiClient;

  constructor(apiBaseUrl?: string, private readonly appVersion?: string) {
    this.authApi = new AuthApiClient(apiBaseUrl, appVersion);
  }

  /**
   * The saved session; throws when there is none.
   */
  async getSession(): Promise<SessionCredentials> {
    const existingSession = await SessionManager.loadSession();
    if (!existingSession) {
      throw new Error('No valid session found. Please login first using browser sign-in: proton-drive-cli login');
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
   * Logout and clear the current session.
   *
   * The server session is revoked (DELETE /auth/v4), its key-password entry
   * removed, then session.json and the crypto cache are deleted unless a new
   * login replaced them meanwhile. A failed revocation is logged and never
   * prevents the local cleanup; without a valid session only an invalid
   * session file is deleted.
   *
   * @returns `revoked`: whether the server session has ended
   */
  async logout(): Promise<{ revoked: boolean }> {
    try {
      const session = await SessionManager.loadSession();
      if (!session) {
        await SessionManager.clearInvalidSession();
        return { revoked: false };
      }
      const revocation = await this.revoke(session);
      if (revocation !== 'signed-out') {
        await SessionManager.removeKeyPassword(session);
        await SessionManager.clearSession(session.uid);
      }
      logger.info('Logged out successfully');
      return { revoked: revocation !== 'failed' };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Logout failed: ${error.message}`);
      }
      throw new Error('Logout failed: Unknown error');
    }
  }

  /**
   * DELETE /auth/v4; an HTTP 401 is answered with one refresh. A rejected
   * refresh token means the session ended elsewhere and was signed out locally.
   */
  private async revoke(session: SessionCredentials): Promise<Revocation> {
    try {
      await this.authApi.logout(session.uid, session.accessToken);
      return 'revoked';
    } catch (error) {
      if (isHttpClientError(error) && error.response?.status === 401) {
        try {
          const refreshed = await SessionManager.refreshSession(session, this.appVersion);
          await this.authApi.logout(refreshed.uid, refreshed.accessToken);
          return 'revoked';
        } catch (retryError) {
          if (retryError instanceof AppError && retryError.details?.signedOut) {
            return 'signed-out';
          }
          logger.warn(`Could not revoke session on server: ${retryError instanceof Error ? retryError.message : retryError}`);
          return 'failed';
        }
      }
      logger.warn(`Could not revoke session on server: ${error instanceof Error ? error.message : error}`);
      return 'failed';
    }
  }
}

export { SessionManager };
