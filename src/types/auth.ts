import type { CredentialStoreName } from '../credentials/types';

/**
 * session.json, written by `proton-drive-cli login` and every token refresh:
 * the non-secret part of a login session. The secrets live in the entry of
 * the session UID in the credential store named here.
 */
export interface SessionRecord {
  uid: string;
  scopes?: string[];
  credentialStore: CredentialStoreName;
  credentialHost: string;
  /**
   * Version 4 UUID (RFC 9562, 5.4) written with each credential-store entry;
   * a reader holding the secrets of this revision needs no store read.
   */
  revision: string;
  /**
   * Unix time (ms) at which the access token expires, from the API's
   * ExpiresIn; absent when the API did not report one (auth/token-expiry.ts).
   */
  tokenExpiresAt?: number;
}

/** The credential-store entry of a session (auth/session-secrets.ts). */
export interface SessionSecrets {
  accessToken: string;
  refreshToken: string;
  keyPassword: string;
}

/** A loaded login session: session.json and the secrets of its entry. */
export interface SessionCredentials extends SessionRecord, SessionSecrets {}

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
