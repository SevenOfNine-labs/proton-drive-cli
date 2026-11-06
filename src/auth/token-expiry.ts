import type { SessionCredentials } from '../types/auth';

export type TokenExpiry = Pick<SessionCredentials, 'tokenExpiresAt'>;

/**
 * Proton access tokens are opaque strings (official account module,
 * `api-auth-types.ts`: `AccessToken: string`), so the only local expiry
 * information is `tokenExpiresAt`, computed from the `ExpiresIn` seconds the
 * API reported when the token was issued or refreshed. A session without it
 * counts as valid until the API answers HTTP 401.
 */
export function resolveTokenExpiresAt(expiresIn: number | undefined, now: number = Date.now()): number | undefined {
  if (expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + expiresIn * 1000;
  }
  return undefined;
}

export function isAccessTokenExpired(session: TokenExpiry, now: number = Date.now()): boolean {
  return session.tokenExpiresAt !== undefined && now >= session.tokenExpiresAt;
}
