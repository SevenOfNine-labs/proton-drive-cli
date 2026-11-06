/**
 * HTTP client adapter for the Proton Drive SDK.
 *
 * Implements ProtonDriveHTTPClient by injecting auth tokens from SessionManager
 * and executing requests with fetch(). Handles token refresh on HTTP 401
 * (Unauthorized) only, like Proton's official clients (go-proton-api, the web
 * client and the SDK account module, apiClient.ts). No Proton error code
 * triggers a refresh: HTTP 403 with code 9101 (insufficient scope) is not
 * refreshable because a refreshed token keeps the same scopes, and code 10013
 * (invalid refresh token) is the refresh endpoint's own rejection, which must
 * never start another refresh. Both are returned as-is so the bridge
 * classifies them.
 */

import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest,
} from '@protontech/drive-sdk';
import { SessionManager } from '../auth/session';
import { assertNotRateLimited, recordRateLimitCooldown } from '../auth/rate-limit';
import { logger } from '../utils/logger';
import { RateLimitError } from '../errors/types';
import { getProtonAppVersion, VENDORED_DRIVE_SDK_VERSION } from '../constants';
import { updateServerTimeFromHeaders } from '../utils/server-time';
import {
  processDriveRequirementHeaders,
  SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
} from '../api/drive-requirements';

const API_BASE_URL = 'https://drive-api.proton.me';

// Proton API error codes that indicate rate-limiting or anti-abuse
const RATE_LIMIT_ERROR_CODES = new Set([
  2028,   // Rate-limiting
  85131,  // Anti-abuse
]);

export class HTTPClientAdapter implements ProtonDriveHTTPClient {
  private refreshInProgress: Promise<void> | null = null;
  private readonly appVersion: string;
  private readonly requirementNoticesEmitted = new Set<string>();

  constructor(appVersion?: string) {
    this.appVersion = getProtonAppVersion(appVersion);
  }

  private async injectAuthHeaders(headers: Headers): Promise<void> {
    await assertNotRateLimited();

    // Use getValidSession() to proactively refresh tokens if expiring soon
    const session = await SessionManager.getValidSession(this.appVersion);
    if (session) {
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      headers.set('x-pm-uid', session.uid);
    }
    // The adapter owns the client identity: always stamp the validated value.
    headers.set('x-pm-appversion', this.appVersion);
    // The vendored SDK reports its package.json placeholder (0.0.1) in
    // x-pm-drive-sdk-version; Proton only stamps the real version at publish
    // time. Report the pinned release instead, as the official CLI does.
    headers.set('x-pm-drive-sdk-version', `js@${VENDORED_DRIVE_SDK_VERSION}`);
  }

  /**
   * Learn from every API response, successful or not: the server clock for
   * OpenPGP operations (see utils/server-time.ts) and Proton's SDK
   * requirement notices, which announce when this build must be updated
   * (for example for the Drive cryptographic model migration).
   */
  private observeResponse(response: Response): void {
    updateServerTimeFromHeaders(response.headers);
    processDriveRequirementHeaders(response.headers, {
      clientSdkVersion: VENDORED_DRIVE_SDK_VERSION,
      supportedRequirementMasksByScope: SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
      onUnsupportedFeature: (scope, requiredMask) => this.warnOnce(
        `Proton Drive requires a ${scope} feature this build does not support ` +
          `(feature mask ${requiredMask}); update the vendored Proton SDK`,
      ),
      onRequiredUpdate: (requiredVersion) => this.warnOnce(
        `Proton Drive requires SDK ${requiredVersion} or newer; this build uses ` +
          `js@${VENDORED_DRIVE_SDK_VERSION} and may be rejected until the vendored Proton SDK is updated`,
      ),
      onSuggestedUpdate: (suggestedVersion) => this.warnOnce(
        `Proton Drive suggests SDK ${suggestedVersion} or newer ` +
          `(this build uses js@${VENDORED_DRIVE_SDK_VERSION})`,
      ),
    });
  }

  /** Emit each notice once per adapter instance (one adapter per bridge command). */
  private warnOnce(message: string): void {
    if (this.requirementNoticesEmitted.has(message)) {
      return;
    }
    this.requirementNoticesEmitted.add(message);
    logger.warn(message);
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
      const cooldown = await recordRateLimitCooldown({
        retryAfter,
        message: 'Rate limit exceeded (HTTP 429)',
      });
      throw new RateLimitError(
        `Rate limit exceeded (HTTP 429)`,
        { retryAfter: cooldown.retryAfter }
      );
    }

    // Check Proton error codes for rate-limiting
    if (!response.ok) {
      try {
        const clone = response.clone();
        const body: any = await clone.json();
        if (body?.Code && RATE_LIMIT_ERROR_CODES.has(body.Code)) {
          logger.warn(`Proton API rate-limit error ${body.Code}: ${body.Error || 'unknown'}`);
          const cooldown = await recordRateLimitCooldown({
            protonCode: body.Code,
            message: body.Error,
          });
          throw new RateLimitError(
            body.Error || `Rate limit exceeded (Proton code ${body.Code})`,
            { retryAfter: cooldown.retryAfter, protonCode: body.Code }
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

  private async refreshTokenIfNeeded(): Promise<void> {
    // Deduplicate concurrent refresh attempts within this process
    if (this.refreshInProgress) {
      return this.refreshInProgress;
    }

    this.refreshInProgress = (async () => {
      try {
        const session = await SessionManager.loadSession();
        if (!session) throw new Error('No session to refresh');

        await SessionManager.refreshSessionOrAdoptRotated(session, this.appVersion);
        logger.info('Token refreshed (reactive, after 401)');
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
    // AbortSignal.any (WHATWG DOM) combines the SDK's signal, including one
    // that is already aborted, with the request budget; no listener to
    // remove afterwards.
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    fetchOpts.signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;

    let response = await fetch(url, fetchOpts);
    this.observeResponse(response);

    // Check for rate-limiting BEFORE attempting token refresh
    // (rate-limit errors should not trigger refresh attempts)
    await this.checkRateLimit(response);

    if (response.status === 401) {
      try {
        await this.refreshTokenIfNeeded();
        await this.injectAuthHeaders(headers);
        response = await fetch(url, fetchOpts);
        this.observeResponse(response);

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
  }

  async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
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

  async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
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
