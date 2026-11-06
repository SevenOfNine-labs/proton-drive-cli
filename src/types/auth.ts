export type AuthMode = 'browser-fork';

export interface SessionCredentials {
  sessionId: string;
  uid: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  passwordMode: number;
  // Authentication path that created the session.
  authMode?: AuthMode;
  // Browser-fork auth returns a key password that must be protected by an OS
  // secret store. It is never written to session.json.
  keyPasswordPersisted?: boolean;
  keyPasswordProvider?: 'git-credential' | 'pass-cli';
  keyPasswordHost?: string;
  // Unix timestamp (ms) at which the access token expires, from the API's
  // ExpiresIn; absent when the API did not report one (see auth/token-expiry.ts).
  tokenExpiresAt?: number;
  // mailboxPassword is intentionally NOT persisted — it flows via stdin
  // from pass-cli on every invocation and stays in memory only.
}

export interface SessionForkInitResponse {
  Code: number;
  Selector: string;
  UserCode: string;
}

export interface SessionForkStatusResponse {
  Code: number;
  Payload: string;
  UID: string;
  AccessToken: string;
  RefreshToken?: string;
  Scopes?: string[];
  // Session-fork may omit PasswordMode; browser-fork then defaults to
  // one-password readiness because the payload carries the user-key password.
  PasswordMode?: number;
  ExpiresIn?: number;
}
