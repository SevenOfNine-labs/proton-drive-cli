import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest,
} from '@protontech/drive-sdk';
import { SessionManager, type SessionTokens } from '../auth/session';
import { assertNotRateLimited, recordRateLimitCooldown } from '../auth/rate-limit';
import { logger } from '../utils/logger';
import { RateLimitError } from '../errors/types';
import { toAppError } from '../errors/classify';
import { DRIVE_SDK_VERSION_HEADER, getProtonAppVersion, VENDORED_DRIVE_SDK_VERSION } from '../constants';
import { updateServerTimeFromHeaders } from '../utils/server-time';
import {
  processDriveRequirementHeaders,
  SUPPORTED_REQUIREMENT_MASK_BY_SCOPE,
} from '../api/drive-requirements';

const API_BASE_URL = 'https://drive-api.proton.me';

/** Proton API codes for rate limiting (2028) and anti-abuse (85131). */
const RATE_LIMIT_ERROR_CODES = new Set([2028, 85131]);

/**
 * ProtonDriveHTTPClient of the Proton Drive SDK: injects the session tokens
 * and refreshes on HTTP 401 only, like Proton's official clients (SDK account
 * module apiClient.ts, go-proton-api). No Proton code triggers a refresh:
 * code 9101 (insufficient scope, HTTP 403) survives a refresh and code 10013
 * is the refresh endpoint's own rejection; both are returned as-is.
 */
export class HTTPClientAdapter implements ProtonDriveHTTPClient {
  private readonly appVersion: string;
  private readonly requirementNoticesEmitted = new Set<string>();

  constructor(appVersion?: string) {
    this.appVersion = getProtonAppVersion(appVersion);
  }

  private async injectAuthHeaders(headers: Headers): Promise<void> {
    await assertNotRateLimited();
    const session = await SessionManager.loadSession();
    if (session) {
      headers.set('Authorization', `Bearer ${session.accessToken}`);
      headers.set('x-pm-uid', session.uid);
    }
    headers.set('x-pm-appversion', this.appVersion);
    headers.set('x-pm-drive-sdk-version', DRIVE_SDK_VERSION_HEADER);
  }

  /**
   * Every response, failed or not, sets the server clock for OpenPGP
   * (utils/server-time.ts) and may carry SDK requirement notices (api/drive-requirements.ts).
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
        if (err instanceof RateLimitError) {
          throw err;
        }
      }
    }
  }

  /**
   * Refresh after an HTTP 401; requests rejected with the same access token
   * share one refresh per process, and SessionManager skips it when the
   * session's token already differs (official ApiClient.refreshSessionIfPossible).
   */
  private async refreshTokenIfNeeded(rejected: SessionTokens): Promise<void> {
    await SessionManager.refreshSessionOrAdoptRotated(rejected, this.appVersion);
    logger.info('Session refreshed after HTTP 401');
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
    await this.checkRateLimit(response);

    if (response.status === 401) {
      try {
        await this.refreshTokenIfNeeded({
          uid: headers.get('x-pm-uid') ?? '',
          accessToken: bearerToken(headers.get('Authorization')),
        });
      } catch (refreshErr) {
        throw toAppError(refreshErr);
      }
      await this.injectAuthHeaders(headers);
      response = await fetch(url, fetchOpts);
      this.observeResponse(response);
      await this.checkRateLimit(response);
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

/** Token of an `Authorization: Bearer <token>` header value, or '' when absent. */
function bearerToken(authorization: string | null): string {
  return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
}
