import { AuthApiClient } from '../api/auth';
import { SRPClient } from './srp';
import { SessionManager } from './session';
import { SessionCredentials } from '../types/auth';
import { AppError, CaptchaError, ErrorCode } from '../errors/types';
import { isHttpClientError } from '../api/http-client';
import { jwtDecode } from 'jwt-decode';
import { logger } from '../utils/logger';

/**
 * Main authentication service
 * Handles login, session management, and token refresh
 */
export class AuthService {
  private authApi: AuthApiClient;

  constructor(apiBaseUrl?: string) {
    this.authApi = new AuthApiClient(apiBaseUrl);
  }

  /**
   * Authenticate with username and password using SRP protocol.
   * Single attempt — no automatic retries. Rate-limit and CAPTCHA errors
   * are surfaced to the caller so the user controls when to retry.
   */
  async login(username: string, password: string, captchaToken?: string): Promise<SessionCredentials> {
    try {
      // Step 1: Get auth info (send CAPTCHA token if available)
      const authInfo = await this.authApi.getAuthInfo(username, captchaToken);

      // Step 2: Compute SRP handshake
      const handshake = await SRPClient.computeHandshake(
        username,
        password,
        authInfo.Salt,
        authInfo.Modulus,
        authInfo.ServerEphemeral,
        authInfo.Version,
        authInfo.Username
      );

      // Step 3: Authenticate
      const authResponse = await this.authApi.authenticate(
        username,
        handshake.clientEphemeral,
        handshake.clientProof,
        authInfo.SRPSession,
        captchaToken
      );

      // Step 4: Verify server proof
      if (!SRPClient.verifyServerProof(
        authResponse.ServerProof,
        handshake.expectedServerProof
      )) {
        throw new Error('Server authentication failed: invalid server proof');
      }

      // Step 5: Create session credentials (password is NOT stored)
      const session: SessionCredentials = {
        sessionId: authResponse.UID,
        uid: authResponse.UID,
        accessToken: authResponse.AccessToken,
        refreshToken: authResponse.RefreshToken,
        scopes: authResponse.Scopes,
        passwordMode: authResponse.PasswordMode,
        userHash: SessionManager.hashUsername(username),
      };

      // Step 6: Save session
      await SessionManager.saveSession(session);
      logger.info('Authentication successful');
      logger.debug(`Session saved (tokens only) to: ${SessionManager.getSessionFilePath()}`);

      return session;
    } catch (error: unknown) {
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
    const currentSession = await SessionManager.loadSession();
    if (!currentSession) {
      throw new Error('No session found. Please login first.');
    }

    try {
      const refreshResponse = await this.authApi.refreshToken(
        currentSession.uid,
        currentSession.refreshToken
      );

      // Update session with new tokens
      const updatedSession: SessionCredentials = {
        ...currentSession,
        accessToken: refreshResponse.AccessToken,
        refreshToken: refreshResponse.RefreshToken,
      };

      await SessionManager.saveSession(updatedSession);
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
