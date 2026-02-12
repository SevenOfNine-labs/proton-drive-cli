export interface AuthInfoResponse {
  Modulus: string;           // Base64-encoded, PGP-signed
  ServerEphemeral: string;   // Base64-encoded
  Version: number;           // Auth version (usually 4)
  Salt: string;              // Base64-encoded
  SRPSession: string;        // Session ID for this auth attempt
  Username?: string;         // Username returned by server (for old auth versions)
}

export interface AuthResponse {
  UID: string;
  AccessToken: string;
  RefreshToken: string;
  TokenType: string;
  Scopes: string[];
  ServerProof: string;       // For verification
  PasswordMode: number;      // 1 = single password, 2 = two password
  '2FA': {
    Enabled: number;
    FIDO2: { RegisteredKeys: Array<{ keyHandle: string; publicKey: string }> };
    TOTP: number;
  };
}

export interface SessionCredentials {
  sessionId: string;
  uid: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  passwordMode: number;
  // mailboxPassword is intentionally NOT persisted — it flows via stdin
  // from pass-cli on every invocation and stays in memory only.
  // SHA-256 hash of the username (lowercase, trimmed) — used to detect
  // when login is called with different credentials than the active session.
  userHash?: string;
}

export interface SRPHandshake {
  clientEphemeral: string;
  clientProof: string;
  expectedServerProof: string;
}
