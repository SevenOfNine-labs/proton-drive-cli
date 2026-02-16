/**
 * HTTP client adapter for the Proton Drive SDK.
 *
 * Implements ProtonDriveHTTPClient by injecting auth tokens from SessionManager
 * and executing requests with fetch(). Handles token refresh on:
 * - HTTP 401 (Unauthorized)
 * - HTTP 403 with Proton error code 9101 (Insufficient scope)
 */

import type { ProtonDriveHTTPClient } from '@protontech/drive-sdk';
import { SessionManager } from '../auth/session';
import { AuthApiClient } from '../api/auth';
import { logger } from '../utils/logger';
import { RateLimitError } from '../errors/types';

// Inline request types to avoid deep import issues
interface HTTPClientBaseRequest {
  url: string;
  method: string;
  headers: Headers;
  timeoutMs: number;
  signal?: AbortSignal;
}

interface HTTPClientJsonRequest extends HTTPClientBaseRequest {
  json?: object;
}

interface HTTPClientBlobRequest extends HTTPClientBaseRequest {
  body?: Uint8Array | ArrayBuffer | string | Blob | ReadableStream;
  onProgress?: (progress: number) => void;
}

const API_BASE_URL = 'https://drive-api.proton.me';

// Use official Proton Drive desktop app version strings (mimics proton-drive-sync)
const PLATFORM_MAP: Record<string, string> = { darwin: 'macos', win32: 'windows', linux: 'macos' };
const PLATFORM = PLATFORM_MAP[process.platform] ?? 'macos';
const APP_VERSION = PLATFORM === 'windows' ? 'windows-drive@1.12.4' : 'macos-drive@2.10.1';

// Proton API error codes that indicate the access token needs refresh
const AUTH_REFRESH_ERROR_CODES = new Set([
  9101,   // Insufficient scope (HTTP 403)
  10013,  // Invalid access token
]);

// Proton API error codes that indicate rate-limiting or anti-abuse
const RATE_LIMIT_ERROR_CODES = new Set([
  2028,   // Rate-limiting
  85131,  // Anti-abuse
]);

export class HTTPClientAdapter implements ProtonDriveHTTPClient {
  private refreshInProgress: Promise<void> | null = null;

  private async injectAuthHeaders(headers: Headers): Promise<void> {
    // Use getValidSession() to proactively refresh tokens if expiring soon
    const session = await SessionManager.getValidSession();
    if (session) {
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      headers.set('x-pm-uid', session.uid);
    }
    // Use official Proton Drive desktop app version string
    if (!headers.has('x-pm-appversion')) {
      headers.set('x-pm-appversion', APP_VERSION);
    }
  }

  private resolveUrl(url: string): string {
    // The SDK provides relative URLs like /drive/v2/volumes
    if (url.startsWith('/')) {
      return `${API_BASE_URL}${url}`;
    }
    return url;
  }

  /**
   * Check if a response indicates rate-limiting.
   * Throws RateLimitError if rate-limiting is detected.
   */
  private async checkRateLimit(response: Response): Promise<void> {
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
      throw new RateLimitError(
        `Rate limit exceeded (HTTP 429)`,
        { retryAfter }
      );
    }

    // Check Proton error codes for rate-limiting
    if (!response.ok) {
      try {
        const clone = response.clone();
        const body: any = await clone.json();
        if (body?.Code && RATE_LIMIT_ERROR_CODES.has(body.Code)) {
          logger.warn(`Proton API rate-limit error ${body.Code}: ${body.Error || 'unknown'}`);
          throw new RateLimitError(
            body.Error || `Rate limit exceeded (Proton code ${body.Code})`,
            { protonCode: body.Code }
          );
        }
      } catch (err) {
        // Re-throw if it's already a RateLimitError
        if (err instanceof RateLimitError) {
          throw err;
        }
        // Response body isn't JSON or parsing failed — not a rate-limit error
      }
    }
  }

  /**
   * Check if a response indicates the token needs to be refreshed.
   * Returns true for HTTP 401 or Proton API auth error codes (e.g. 9101).
   *
   * For non-401 errors, clones the response and peeks at the JSON body
   * to check the Proton error code without consuming the original response.
   */
  private async needsTokenRefresh(response: Response): Promise<boolean> {
    if (response.status === 401) {
      return true;
    }

    // Only check JSON body for non-2xx responses that might carry Proton error codes
    if (response.ok) {
      return false;
    }

    try {
      const clone = response.clone();
      const body: any = await clone.json();
      if (body?.Code && AUTH_REFRESH_ERROR_CODES.has(body.Code)) {
        logger.debug(`Proton API error ${body.Code}: ${body.Error || 'unknown'} — attempting token refresh`);
        return true;
      }
    } catch {
      // Response body isn't JSON — not an auth error
    }

    return false;
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    // Deduplicate concurrent refresh attempts within this process
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = (async () => {
      try {
        const session = await SessionManager.loadSession();
        if (!session) throw new Error('No session to refresh');

        // Store original access token to detect cross-process updates
        const originalAccessToken = session.accessToken;

        const authApi = new AuthApiClient();
        try {
          const refreshResult = await authApi.refreshToken(session.uid, session.refreshToken);

          // Calculate token expiration time
          const tokenExpiresAt = refreshResult.ExpiresIn
            ? Date.now() + (refreshResult.ExpiresIn * 1000)
            : undefined;

          await SessionManager.saveSession({
            ...session,
            accessToken: refreshResult.AccessToken,
            refreshToken: refreshResult.RefreshToken,
            tokenExpiresAt,
          });
          logger.info('Token refreshed successfully (reactive, after 401)');
        } catch (refreshErr) {
          // Refresh token may have been consumed by another subprocess.
          // Re-read the session file — another process may have already
          // written a fresh token pair.
          logger.debug('Refresh failed, re-reading session file (possible cross-process race)');
          const updatedSession = await SessionManager.loadSession();
          if (
            updatedSession &&
            updatedSession.accessToken !== originalAccessToken
          ) {
            // Another process already refreshed — use the new tokens
            logger.info('Session refreshed by another process, using updated tokens');
            return;
          }
          // Session unchanged — the refresh truly failed
          logger.warn('Token refresh failed and no cross-process update detected');
          throw refreshErr;
        }
      } finally {
        this.refreshInProgress = null;
      }
    })();

    return this.refreshInProgress;
  }

  /**
   * Execute a fetch, check the response for auth errors, and retry once
   * after refreshing the token if needed.
   */
  private async fetchWithRefresh(
    url: string,
    fetchOpts: RequestInit,
    headers: Headers,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort());
    }
    fetchOpts.signal = controller.signal;

    try {
      let response = await fetch(url, fetchOpts);

      // Check for rate-limiting BEFORE attempting token refresh
      // (rate-limit errors should not trigger refresh attempts)
      await this.checkRateLimit(response);

      if (await this.needsTokenRefresh(response)) {
        try {
          await this.refreshTokenIfNeeded();
          await this.injectAuthHeaders(headers);
          response = await fetch(url, fetchOpts);

          // Check rate-limiting on retry response as well
          await this.checkRateLimit(response);
        } catch (refreshErr) {
          // Re-throw rate-limit errors immediately
          if (refreshErr instanceof RateLimitError) {
            throw refreshErr;
          }
          logger.warn(`Token refresh failed: ${refreshErr instanceof Error ? refreshErr.message : refreshErr}`);
          // Return the original error response so the caller gets the API error
        }
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async fetchJson(request: HTTPClientJsonRequest): Promise<Response> {
    await this.injectAuthHeaders(request.headers);
    const url = this.resolveUrl(request.url);

    const fetchOpts: RequestInit = {
      method: request.method,
      headers: request.headers,
    };

    if (request.json) {
      request.headers.set('Content-Type', 'application/json');
      fetchOpts.body = JSON.stringify(request.json);
    }

    return this.fetchWithRefresh(url, fetchOpts, request.headers, request.timeoutMs, request.signal);
  }

  async fetchBlob(request: HTTPClientBlobRequest): Promise<Response> {
    await this.injectAuthHeaders(request.headers);
    const url = this.resolveUrl(request.url);

    const fetchOpts: RequestInit = {
      method: request.method,
      headers: request.headers,
    };

    if (request.body) {
      fetchOpts.body = request.body as NonNullable<RequestInit['body']>;
    }

    return this.fetchWithRefresh(url, fetchOpts, request.headers, request.timeoutMs, request.signal);
  }
}
