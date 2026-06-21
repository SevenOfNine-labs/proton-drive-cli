import { HttpClient } from './http-client';
import {
  Auth2FARequest,
  AuthInfoResponse,
  AuthResponse,
  SessionForkInitResponse,
  SessionForkStatusResponse,
} from '../types/auth';
import { CaptchaError } from '../errors/types';
import { logger } from '../utils/logger';
import { redactSensitive } from '../utils/redaction';
import { getProtonAppVersion } from '../constants';

/**
 * Authentication API client for Proton API
 * Handles SRP authentication flow with Proton's API
 */
export class AuthApiClient {
  private client: HttpClient;
  private baseUrl: string;

  constructor(
    baseUrl: string = 'https://drive-api.proton.me',
    appVersion?: string
  ) {
    this.baseUrl = baseUrl;
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
   * Get authentication info (Step 1 of SRP auth)
   * @param username - User's email address
   * @param captchaToken - Optional CAPTCHA verification token
   * @returns Auth info including SRP parameters
   */
  async getAuthInfo(username: string, captchaToken?: string): Promise<AuthInfoResponse> {
    try {
      const headers: any = {};
      if (captchaToken) {
        // Proton API requires TWO separate headers for human verification
        // See: https://github.com/ProtonMail/proton-python-client
        headers['X-PM-Human-Verification-Token-Type'] = 'captcha';
        headers['X-PM-Human-Verification-Token'] = captchaToken;
        logger.debug(`Sending CAPTCHA headers to getAuthInfo`);
        logger.debug(`  X-PM-Human-Verification-Token-Type: captcha`);
      }

      const response = await this.client.post<AuthInfoResponse>(
        '/auth/v4/info',
        { Username: username },
        { headers }
      );
      return response.data;
    } catch (error: any) {
      this.throwIfHumanVerification(error, 'getAuthInfo');
      if (error.response) {
        logger.debug('API Error Response:', JSON.stringify(redactSensitive(error.response.data), null, 2));
        logger.debug('Status:', error.response.status);
      }
      throw error;
    }
  }

  /**
   * Authenticate with SRP proofs (Step 2 of SRP auth)
   * @param username - User's email address
   * @param clientEphemeral - Client ephemeral value (base64)
   * @param clientProof - Client proof (base64)
   * @param srpSession - SRP session ID from auth/info
   * @param captchaToken - Optional CAPTCHA verification token
   * @returns Authentication response with tokens
   */
  async authenticate(
    username: string,
    clientEphemeral: string,
    clientProof: string,
    srpSession: string,
    captchaToken?: string
  ): Promise<AuthResponse> {
    try {
      const headers: any = {};
      if (captchaToken) {
        // Proton API requires TWO separate headers for human verification
        // See: https://github.com/ProtonMail/proton-python-client
        headers['X-PM-Human-Verification-Token-Type'] = 'captcha';
        headers['X-PM-Human-Verification-Token'] = captchaToken;
        logger.debug(`Sending CAPTCHA headers to authenticate()`);
        logger.debug(`  X-PM-Human-Verification-Token-Type: captcha`);
      }

      const response = await this.client.post<AuthResponse>(
        '/auth/v4',
        {
          Username: username,
          ClientEphemeral: clientEphemeral,
          ClientProof: clientProof,
          SRPSession: srpSession,
        },
        { headers }
      );

      const data = response.data;
      if (!data.UID || !data.AccessToken || !data.RefreshToken || !data.ServerProof) {
        throw new Error('Incomplete auth response: missing required tokens');
      }
      return data;
    } catch (error: any) {
      this.throwIfHumanVerification(error, 'authenticate');
      if (error.response) {
        logger.debug('API Error Response:', JSON.stringify(redactSensitive(error.response.data), null, 2));
        logger.debug('Status:', error.response.status);
      }
      throw error;
    }
  }

  /**
   * Complete second-factor authorization for an authenticated SRP session.
   *
   * This is a separate Proton API step after /auth/v4 when authResponse['2FA']
   * reports TOTP or FIDO2 requirements. Non-interactive bridge flows should
   * only call this when a single-use TOTP code was explicitly provided.
   */
  async complete2FA(
    uid: string,
    accessToken: string,
    request: Auth2FARequest
  ): Promise<void> {
    if (!request.TwoFactorCode && !request.FIDO2) {
      throw new Error('TwoFactorCode or FIDO2 assertion is required');
    }

    await this.client.post('/auth/v4/2fa', request, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'x-pm-uid': uid,
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
   * Check if an API error requires human verification (CAPTCHA).
   * Proton can signal this via code 9001 OR via HumanVerificationToken in
   * Details on other error codes (e.g. 2028). Check the Details field
   * regardless of the error code.
   */
  private throwIfHumanVerification(error: any, context: string): void {
    const data = error.response?.data;
    if (!data) return;

    const details = data.Details;
    if (details?.HumanVerificationToken) {
      logger.debug(`${context} human verification required (Code: ${data.Code}):`,
        JSON.stringify(redactSensitive(details), null, 2));
      throw new CaptchaError({
        captchaUrl: details.WebUrl,
        captchaToken: details.HumanVerificationToken,
        verificationMethods: details.HumanVerificationMethods,
      });
    }
  }

  /**
   * Refresh access token using refresh token
   * @param uid - User ID
   * @param refreshToken - Refresh token
   * @returns New access and refresh tokens
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
   * Logout and revoke current session
   * @param accessToken - Current access token
   */
  async logout(accessToken: string): Promise<void> {
    await this.client.delete('/auth/v4', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });
  }
}
