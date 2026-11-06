import { HttpClient } from './http-client';
import {
  RefreshTokenResponse,
  SessionForkInitResponse,
  SessionForkStatusResponse,
} from '../types/auth';
import { DRIVE_SDK_VERSION_HEADER, getProtonAppVersion } from '../constants';

/**
 * Proton authentication endpoints of the browser session-fork flow
 * (official account module, accountApi.ts and apiClient.ts): fork init and
 * status, token refresh and session revocation.
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
        'x-pm-drive-sdk-version': DRIVE_SDK_VERSION_HEADER,
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
   * Exchange the refresh token for a new token pair (POST /auth/v4/refresh).
   *
   * Sent as an authenticated request carrying the rejected access token, with
   * the body of the official ApiClient.performTokenRefresh (apiClient.ts). A
   * response without RefreshToken or UID keeps the current value.
   */
  async refreshToken(
    uid: string,
    accessToken: string,
    refreshToken: string,
  ): Promise<RefreshTokenResponse> {
    const response = await this.client.post<Partial<RefreshTokenResponse>>('/auth/v4/refresh', {
      ResponseType: 'token',
      GrantType: 'refresh_token',
      RefreshToken: refreshToken,
    }, {
      headers: {
        'x-pm-uid': uid,
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const data = response.data ?? {};
    if (!data.AccessToken) {
      throw new Error('Incomplete refresh response: missing AccessToken');
    }
    return {
      UID: data.UID ?? uid,
      AccessToken: data.AccessToken,
      RefreshToken: data.RefreshToken ?? refreshToken,
      ExpiresIn: data.ExpiresIn,
    };
  }

  /**
   * Revoke the session on the server (DELETE /auth/v4).
   *
   * Authenticated Proton calls identify the session with both headers
   * (official account module, apiClient.ts: `x-pm-uid` and
   * `Authorization: Bearer`); without the UID the API cannot match the token
   * to a session.
   */
  async logout(uid: string, accessToken: string): Promise<void> {
    await this.client.delete('/auth/v4', {
      headers: {
        'x-pm-uid': uid,
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  }
}
