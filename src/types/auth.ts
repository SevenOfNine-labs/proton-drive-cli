import type { ProviderName } from '../credentials/types';

/**
 * Session written by `proton-drive-cli login` (session.json). The key
 * password itself lives in the credential provider named here, never in the
 * file.
 */
export interface SessionCredentials {
  uid: string;
  accessToken: string;
  refreshToken: string;
  scopes?: string[];
  keyPasswordProvider: ProviderName;
  keyPasswordHost: string;
  /**
   * Unix time (ms) at which the access token expires, from the API's
   * ExpiresIn; absent when the API did not report one (auth/token-expiry.ts).
   */
  tokenExpiresAt?: number;
}

/** Response of GET /auth/v4/sessions/forks (official accountApi.ts sessionForksInit). */
export interface SessionForkInitResponse {
  Code: number;
  Selector: string;
  UserCode: string;
}

/** Response of GET /auth/v4/sessions/forks/{selector} (official accountApi.ts sessionForksStatus). */
export interface SessionForkStatusResponse {
  Code: number;
  Payload: string;
  UID: string;
  AccessToken: string;
  RefreshToken?: string;
  Scopes?: string[];
  ExpiresIn?: number;
}

/** Response of POST /auth/v4/refresh (official apiClient.ts performTokenRefresh). */
export interface RefreshTokenResponse {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  ExpiresIn?: number;
}
