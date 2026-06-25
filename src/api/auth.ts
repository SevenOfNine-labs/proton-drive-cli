import { HttpClient } from './http-client';
import {
  SessionForkInitResponse,
  SessionForkStatusResponse,
} from '../types/auth';
import { getProtonAppVersion } from '../constants';

/**
 * Authentication API client for the Proton API surfaces this CLI is allowed to
 * use in production: browser session-fork, token refresh, and logout.
 *
 * Direct account-password/SRP login is intentionally not implemented here.
 */
export class AuthApiClient {
  private client: HttpClient;

  constructor(
    baseUrl: string = 'https://drive-api.proton.me',
    appVersion?: string
  ) {
    const resolvedAppVersion = getProtonAppVersion(appVersion);
    this.client = HttpClient.create({
      baseURL: baseUrl,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'x-pm-appversion': resolvedAppVersion,
      },
    });
  }

  /**
   * Start Proton's browser session-fork login flow.
   *
   * This mirrors the official SDK CLI's unauthenticated
   * GET /auth/v4/sessions/forks call. The returned UserCode is embedded into
   * the account.proton.me desktop-login URL; Selector is used for polling.
   */
  async initSessionFork(): Promise<SessionForkInitResponse> {
    const response = await this.client.get<SessionForkInitResponse>(
      '/auth/v4/sessions/forks'
    );

    const data = response.data;
    if (!data.Selector || !data.UserCode) {
      throw new Error('Incomplete session fork init response');
    }
    return data;
  }

  /**
   * Poll Proton's browser session-fork login flow.
   *
   * Proton returns HTTP 422 while the browser sign-in is still pending. Callers
   * should handle that status as "not ready yet" and keep polling within their
   * own timeout budget.
   */
  async getSessionForkStatus(selector: string): Promise<SessionForkStatusResponse> {
    const response = await this.client.get<SessionForkStatusResponse>(
      `/auth/v4/sessions/forks/${encodeURIComponent(selector)}`
    );

    const data = response.data;
    if (!data.Payload || !data.UID || !data.AccessToken) {
      throw new Error('Incomplete session fork status response');
    }
    return data;
  }

  /**
   * Refresh access token using refresh token.
   */
  async refreshToken(
    uid: string,
    refreshToken: string
  ): Promise<{ AccessToken: string; RefreshToken: string; ExpiresIn?: number }> {
    const response = await this.client.post('/auth/v4/refresh', {
      UID: uid,
      RefreshToken: refreshToken,
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RedirectURI: 'http://proton.me',
    }, {
      headers: { 'x-pm-uid': uid },
    });

    const data = response.data;
    if (!data.AccessToken || !data.RefreshToken) {
      throw new Error('Incomplete refresh response: missing tokens');
    }
    return data;
  }

  /**
   * Logout and revoke current session.
   */
  async logout(accessToken: string): Promise<void> {
    await this.client.delete('/auth/v4', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  }
}
