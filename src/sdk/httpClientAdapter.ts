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

// Proton API error codes that indicate the access token needs refresh
const AUTH_REFRESH_ERROR_CODES = new Set([
  9101,   // Insufficient scope (HTTP 403)
  10013,  // Invalid access token
]);

export class HTTPClientAdapter implements ProtonDriveHTTPClient {
  private refreshInProgress: Promise<void> | null = null;

  private async injectAuthHeaders(headers: Headers): Promise<void> {
    const session = await SessionManager.loadSession();
    if (session) {
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      headers.set('x-pm-uid', session.uid);
    }
    // Required by Proton API — must match the value used during auth
    if (!headers.has('x-pm-appversion')) {
      headers.set('x-pm-appversion', 'web-drive@5.2.0');
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

        const authApi = new AuthApiClient();
        try {
          const refreshResult = await authApi.refreshToken(session.uid, session.refreshToken);
          await SessionManager.saveSession({
            ...session,
            accessToken: refreshResult.AccessToken,
            refreshToken: refreshResult.RefreshToken,
          });
          logger.info('Token refreshed successfully');
        } catch (refreshErr) {
          // Refresh token may have been consumed by another subprocess.
          // Re-read the session file — another process may have already
          // written a fresh token pair.
          logger.debug('Refresh failed, re-reading session file (possible cross-process race)');
          const updatedSession = await SessionManager.loadSession();
          if (
            updatedSession &&
            updatedSession.accessToken !== session.accessToken
          ) {
            // Another process already refreshed — use the new tokens
            logger.info('Session refreshed by another process, using updated tokens');
            return;
          }
          // Session unchanged — the refresh truly failed
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

      if (await this.needsTokenRefresh(response)) {
        try {
          await this.refreshTokenIfNeeded();
          await this.injectAuthHeaders(headers);
          response = await fetch(url, fetchOpts);
        } catch (refreshErr) {
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
