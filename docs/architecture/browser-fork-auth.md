# Browser Fork Authentication

## Status

Browser fork authentication is experimental and must stay behind
`proton-drive-cli login --auth-mode browser-fork` until the key-password
storage story is complete.

This path is modeled on the official Proton SDK CLI implementation in
`submodules/sdk/js/cli/src/api/auth.ts` and `authWeb.ts`:

1. Start a fork with unauthenticated `GET /auth/v4/sessions/forks`.
2. Generate an `account.proton.me/desktop/login?app=drive&pv=3` URL with a
   fragment payload containing the user code, a random 32-byte AES key, and
   the auth client id.
3. Open the URL for the user and poll
   `GET /auth/v4/sessions/forks/:selector`.
4. Treat HTTP 422 as "not approved yet".
5. Decrypt the returned payload with AES-256-GCM using AAD `fork`.
6. Persist only the account tokens and session metadata.

## Safety Contract

The fork payload contains `keyPassword`, which is needed to unlock Proton user
keys for Drive operations. Proton's official CLI stores that secret in an OS
secret store. This project does not yet have that integration, so the
experimental implementation validates the encrypted payload but does not write
`keyPassword` to `~/.proton-drive-cli/session.json`.

Browser-fork sessions are persisted with:

```json
{
  "authMode": "browser-fork",
  "keyPasswordPersisted": false
}
```

The bridge `auth-state` command treats those sessions as
`needs_data_password` unless the caller provides a mailbox/data password source
through `dataPassword` or `dataCredentialProvider`. This prevents root-level
Git LFS transfers from reporting `ready` only to fail later during SDK crypto
initialization.

## Testing Rules

Do not use real Proton accounts to test this path until the mocked tests and
offline auth-state checks pass. Safe tests are:

- Unit tests for URL generation and AES-GCM payload parsing.
- Mocked session-fork API tests with HTTP 422 polling.
- Bridge `auth-state` tests for browser-fork session metadata.
- Root adapter dry-run/auth-state checks that do not contact Proton.

Real-login validation, when explicitly approved, should use a dedicated
low-risk account and a single attempt after confirming no active
rate-limit-cooldown file exists.
