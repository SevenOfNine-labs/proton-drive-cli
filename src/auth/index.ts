import { AuthApiClient } from '../api/auth';
import { isHttpClientError } from '../api/http-client';
import { AppError } from '../errors/types';
import { SessionManager } from './session';
import { SessionCredentials } from '../types/auth';
import { logger } from '../utils/logger';

/**
 * Outcome of DELETE /auth/v4 for a session being logged out; `signed-out`
 * carries whether that sign-out removed the credential-store entry.
 */
type Revocation = 'revoked' | 'failed' | { signedOut: true; credentialsRemoved: boolean };

/**
 * Lifecycle of an existing session: authentication check and logout. Sessions are
 * created only by BrowserForkAuthService (`proton-drive-cli login`).
 */
export class AuthService {
  private authApi: AuthApiClient;

  constructor(apiBaseUrl?: string, private readonly appVersion?: string) {
    this.authApi = new AuthApiClient(apiBaseUrl, appVersion);
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
   * The server session is revoked (DELETE /auth/v4) with the tokens of its
   * credential-store entry; session.json and the crypto cache are deleted
   * under the session lock unless a new login replaced them meanwhile, then
   * the entry is removed, so a refresh in flight cannot leave a new entry
   * behind. A failed revocation, or an entry that cannot be read, is logged
   * and never prevents the local cleanup; without a valid session only an
   * invalid session file is deleted.
   *
   * @returns `revoked`: whether the server session has ended;
   *   `credentialsRemoved`: whether the credential-store entry is gone
   */
  async logout(): Promise<{ revoked: boolean; credentialsRemoved: boolean }> {
    try {
      const stored = await SessionManager.readStoredSession();
      if (stored.kind !== 'valid') {
        await SessionManager.clearInvalidSession();
        return { revoked: false, credentialsRemoved: true };
      }
      const { record } = stored;
      const session = await SessionManager.loadSession().catch((error: unknown) => {
        logger.warn(`Cannot revoke the session on the server: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const revocation: Revocation = session?.uid === record.uid ? await this.revoke(session) : 'failed';
      if (typeof revocation === 'object') {
        logger.info('Logged out successfully');
        return { revoked: true, credentialsRemoved: revocation.credentialsRemoved };
      }
      await SessionManager.clearSession(record.uid);
      const credentialsRemoved = await SessionManager.removeSecrets(record);
      logger.info('Logged out successfully');
      return { revoked: revocation === 'revoked', credentialsRemoved };
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
            return { signedOut: true, credentialsRemoved: retryError.details.credentialsRemoved !== false };
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
