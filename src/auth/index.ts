import { AuthApiClient } from '../api/auth';
import { SRPClient } from './srp';
import { SessionManager } from './session';
import { createKeyPasswordStore } from './key-password-store';
import { AuthResponse, SessionCredentials } from '../types/auth';
import { AppError, CaptchaError, ErrorCode } from '../errors/types';
import { HttpClientError, isHttpClientError } from '../api/http-client';
import { jwtDecode } from 'jwt-decode';
import { logger } from '../utils/logger';
import { authTrace, maskIdentifier } from '../utils/auth-trace';

interface LoginOptions {
  captchaToken?: string;
  secondFactorCode?: string;
}

type AuthStage = 'auth-info' | 'auth-submit' | 'two-factor';

const AUTH_STAGE_ENDPOINT: Record<AuthStage, string> = {
  'auth-info': '/auth/v4/info',
  'auth-submit': '/auth/v4',
  'two-factor': '/auth/v4/2fa',
};

const AUTH_STAGE_LABEL: Record<AuthStage, string> = {
  'auth-info': 'auth-info',
  'auth-submit': 'auth-submit',
  'two-factor': 'two-factor',
};

const TWO_FACTOR_TOTP = 1;
const TWO_FACTOR_FIDO2 = 2;
const TWO_FACTOR_FIDO2_AND_TOTP = 3;

/**
 * Main authentication service
 * Handles login, session management, and token refresh
 */
export class AuthService {
  private authApi: AuthApiClient;

  constructor(apiBaseUrl?: string, private readonly appVersion?: string) {
    this.authApi = new AuthApiClient(apiBaseUrl, appVersion);
  }

  /**
   * Authenticate with username and password using SRP protocol.
   * Single attempt — no automatic retries. Rate-limit and CAPTCHA errors
   * are surfaced to the caller so the user controls when to retry.
   */
  async login(
    username: string,
    password: string,
    optionsOrCaptchaToken?: LoginOptions | string
  ): Promise<SessionCredentials> {
    const options = this.normalizeLoginOptions(optionsOrCaptchaToken);
    try {
      authTrace('auth.login.start', {
        username: maskIdentifier(username),
        captchaTokenPresent: Boolean(options.captchaToken),
        secondFactorCodePresent: Boolean(options.secondFactorCode),
      });

      // Step 1: Get auth info (send CAPTCHA token if available)
      const authInfo = await this.runAuthStage('auth-info', () =>
        this.authApi.getAuthInfo(username, options.captchaToken)
      );

      // Step 2: Compute SRP handshake
      const handshake = await this.runLocalAuthStep('srp-handshake', () =>
        SRPClient.computeHandshake(
          username,
          password,
          authInfo.Salt,
          authInfo.Modulus,
          authInfo.ServerEphemeral,
          authInfo.Version,
          authInfo.Username
        )
      );

      // Step 3: Authenticate
      const authResponse = await this.runAuthStage('auth-submit', () =>
        this.authApi.authenticate(
          username,
          handshake.clientEphemeral,
          handshake.clientProof,
          authInfo.SRPSession,
          options.captchaToken
        )
      );

      // Step 4: Verify server proof
      authTrace('auth.server-proof.start');
      if (!SRPClient.verifyServerProof(
        authResponse.ServerProof,
        handshake.expectedServerProof
      )) {
        authTrace('auth.server-proof.failure', { reason: 'invalid-server-proof' });
        throw new Error('Server authentication failed: invalid server proof');
      }
      authTrace('auth.server-proof.success');

      // Step 5: Complete mandatory 2FA before persisting any session.
      await this.runAuthStage('two-factor', () =>
        this.completeTwoFactorIfRequired(authResponse, options.secondFactorCode)
      );

      // Step 6: Calculate token expiration time
      // Initial login response doesn't include ExpiresIn, so decode JWT to get expiry
      let tokenExpiresAt: number | undefined;
      try {
        const decoded = jwtDecode<{ exp?: number }>(authResponse.AccessToken);
        if (decoded.exp) {
          tokenExpiresAt = decoded.exp * 1000; // Convert seconds to milliseconds
          logger.debug(`Token expires at: ${new Date(tokenExpiresAt).toISOString()}`);
        }
      } catch (err) {
        logger.debug('Could not decode JWT for expiry time (non-JWT token?)');
      }

      // Step 7: Create session credentials (password is NOT stored)
      const session: SessionCredentials = {
        sessionId: authResponse.UID,
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken,
        refreshToken: authResponse.RefreshToken,
        scopes: authResponse.Scopes,
        passwordMode: authResponse.PasswordMode,
        authMode: 'srp',
        tokenExpiresAt,
        userHash: SessionManager.hashUsername(username),
      };

      // Step 8: Save session
      authTrace('auth.session-save.start', {
        sessionFile: SessionManager.getSessionFilePath(),
        passwordMode: authResponse.PasswordMode,
        scopes: authResponse.Scopes,
      });
      await SessionManager.saveSession(session);
      authTrace('auth.session-save.success', {
        sessionFile: SessionManager.getSessionFilePath(),
      });
      logger.info('Authentication successful');
      logger.debug(`Session saved (tokens only) to: ${SessionManager.getSessionFilePath()}`);
      authTrace('auth.login.success', {
        username: maskIdentifier(username),
        passwordMode: authResponse.PasswordMode,
      });

      return session;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }

      if (error instanceof CaptchaError) {
        throw error;
      }

      // Proton API rate-limit (code 2028) — surface actual message, no auto-retry
      if (isHttpClientError(error)) {
        const data = error.response?.data as Record<string, unknown> | undefined;
        const protonCode = data?.Code;
        if (protonCode === 2028) {
          const apiMessage = (data?.Error as string) || 'Too many requests';
          throw new AppError(
            apiMessage,
            ErrorCode.RATE_LIMITED,
            { protonCode, httpStatus: error.response?.status, apiMessage },
            true
          );
        }
      }

      if (error instanceof Error) {
        throw new Error(`Login failed: ${error.message}`);
      }
      throw new Error('Login failed: Unknown error');
    }
  }

  private normalizeLoginOptions(optionsOrCaptchaToken?: LoginOptions | string): LoginOptions {
    if (typeof optionsOrCaptchaToken === 'string') {
      return { captchaToken: optionsOrCaptchaToken };
    }
    return optionsOrCaptchaToken || {};
  }

  private async runAuthStage<T>(stage: AuthStage, operation: () => Promise<T>): Promise<T> {
    const start = Date.now();
    authTrace('auth.stage.start', {
      stage,
      endpoint: AUTH_STAGE_ENDPOINT[stage],
    });

    try {
      const result = await operation();
      authTrace('auth.stage.success', {
        stage,
        endpoint: AUTH_STAGE_ENDPOINT[stage],
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error: unknown) {
      authTrace('auth.stage.failure', {
        stage,
        endpoint: AUTH_STAGE_ENDPOINT[stage],
        durationMs: Date.now() - start,
        ...this.authTraceErrorFields(error),
      });

      if (error instanceof AppError || error instanceof CaptchaError) {
        throw error;
      }

      if (isHttpClientError(error)) {
        const data = error.response?.data as Record<string, unknown> | undefined;
        const protonCode = data?.Code;

        // Keep the existing rate-limit path so cooldown metadata is preserved.
        if (protonCode === 2028 || error.response?.status === 429) {
          throw error;
        }

        throw new AppError(
          `Login failed during ${AUTH_STAGE_LABEL[stage]}: ${error.message}`,
          this.authStageErrorCode(error),
          {
            authStage: stage,
            endpoint: AUTH_STAGE_ENDPOINT[stage],
            clientCode: error.code,
            httpStatus: error.response?.status,
            protonCode,
            apiMessage: data?.Error,
            originalError: error.message,
          },
          this.isRecoverableAuthStageError(error)
        );
      }

      throw error;
    }
  }

  private async runLocalAuthStep<T>(step: string, operation: () => Promise<T>): Promise<T> {
    const start = Date.now();
    authTrace('auth.local-step.start', { step });
    try {
      const result = await operation();
      authTrace('auth.local-step.success', {
        step,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error: unknown) {
      authTrace('auth.local-step.failure', {
        step,
        durationMs: Date.now() - start,
        ...this.authTraceErrorFields(error),
      });
      throw error;
    }
  }

  private authTraceErrorFields(error: unknown): Record<string, unknown> {
    if (isHttpClientError(error)) {
      const data = error.response?.data as Record<string, unknown> | undefined;
      return {
        errorName: error.name,
        errorMessage: error.message,
        clientCode: error.code,
        httpStatus: error.response?.status,
        protonCode: data?.Code,
        apiMessage: data?.Error,
      };
    }

    if (error instanceof AppError) {
      return {
        errorName: error.name,
        errorCode: error.code,
        errorMessage: error.message,
        details: error.details,
      };
    }

    if (error instanceof Error) {
      return {
        errorName: error.name,
        errorMessage: error.message,
      };
    }

    return { errorMessage: String(error) };
  }

  private authStageErrorCode(error: HttpClientError): ErrorCode {
    if (!error.response) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        return ErrorCode.TIMEOUT;
      }
      if (error.code === 'ECONNREFUSED') {
        return ErrorCode.CONNECTION_REFUSED;
      }
      return ErrorCode.NETWORK_ERROR;
    }
    if (error.response.status === 400 || error.response.status === 401) {
      return ErrorCode.AUTH_FAILED;
    }
    if (error.response.status >= 500) {
      return ErrorCode.API_ERROR;
    }
    return ErrorCode.API_ERROR;
  }

  private isRecoverableAuthStageError(error: HttpClientError): boolean {
    if (!error.response) {
      return true;
    }
    return error.response.status >= 500;
  }

  private async completeTwoFactorIfRequired(
    authResponse: AuthResponse,
    secondFactorCode?: string
  ): Promise<void> {
    const twoFactorStatus = authResponse['2FA']?.Enabled || 0;
    if (twoFactorStatus === 0) return;

    const totpAllowed =
      twoFactorStatus === TWO_FACTOR_TOTP ||
      twoFactorStatus === TWO_FACTOR_FIDO2_AND_TOTP;

    if (totpAllowed && secondFactorCode) {
      await this.authApi.complete2FA(
        authResponse.UID,
        authResponse.AccessToken,
        { TwoFactorCode: secondFactorCode }
      );
      return;
    }

    const factorType = twoFactorStatus === TWO_FACTOR_FIDO2 ? 'fido2' : 'totp';
    const message = factorType === 'fido2'
      ? 'FIDO2 two-factor authentication is required'
      : 'Two-factor authentication code required';

    throw new AppError(
      message,
      ErrorCode.TWO_FACTOR_REQUIRED,
      {
        twoFactorType: factorType,
        fido2Available: Boolean(authResponse['2FA']?.FIDO2?.RegisteredKeys?.length),
        totpAllowed,
      },
      true
    );
  }

  /**
   * Get current session or throw error if not authenticated
   * @returns Current session credentials
   */
  async getSession(): Promise<SessionCredentials> {
    const existingSession = await SessionManager.loadSession();
    if (!existingSession) {
      throw new Error('No valid session found. Please login first using: proton-drive login');
    }

    if (this.isTokenExpiringSoon(existingSession.accessToken)) {
      return await this.refreshSession();
    }

    return existingSession;
  }

  /**
   * Check if a JWT token is expiring soon (within 5 minutes)
   */
  private isTokenExpiringSoon(token: string): boolean {
    try {
      const decoded = jwtDecode<{ exp: number }>(token);
      if (!decoded.exp) return false;
      const now = Math.floor(Date.now() / 1000);
      return (decoded.exp - now) < 5 * 60;
    } catch {
      return false;
    }
  }

  /**
   * Check if user is currently authenticated
   * @returns True if authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    return await SessionManager.hasValidSession();
  }

  /**
   * Refresh the access token using the refresh token
   * @returns Updated session credentials
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
   * Logout and clear the current session
   */
  async logout(): Promise<void> {
    try {
      // Try to revoke session on server
      const session = await SessionManager.loadSession();
      if (session) {
        try {
          await this.authApi.logout(session.accessToken);
        } catch (error) {
          // Ignore errors from server (session might be already invalid)
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

      // Clear local session and crypto cache
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

// Export session manager for direct access if needed
export { SessionManager };
export { SRPClient };
