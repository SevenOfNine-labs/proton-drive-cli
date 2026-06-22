# Browser Fork Authentication

## Status

Browser fork authentication is experimental and must stay behind
`proton-drive-cli login --auth-mode browser-fork` until disposable-account
canary evidence proves the flow against current Proton production behavior.

This path is modeled on the official Proton SDK CLI implementation in
`submodules/sdk/cli/src/api/auth.ts` and `authWeb.ts`:

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
secret store. This project stores the derived key password in a configured
credential provider and verifies readback before saving the browser-fork
session. The secret is never written to `~/.proton-drive-cli/session.json`.

Key-password provider selection is explicit:

- `--key-password-provider <git-credential|pass-cli>` wins.
- `--credential-provider <git-credential|pass-cli>` is used as a browser-fork
  key-password provider fallback.
- `PROTON_KEY_PASSWORD_PROVIDER` and then `PROTON_CREDENTIAL_PROVIDER` are used
  when command flags are absent.
- `--key-password-host` or `PROTON_KEY_PASSWORD_HOST` can override the default
  `proton-drive-key.proton-lfs-cli.local` credential host.

Browser-fork sessions are persisted with:

```json
{
  "authMode": "browser-fork",
  "keyPasswordPersisted": true,
  "keyPasswordProvider": "git-credential",
  "keyPasswordHost": "proton-drive-key.proton-lfs-cli.local"
}
```

If key-password storage fails or readback verification fails, the login command
does not save the session. If session save fails after key-password storage, it
attempts to remove the stored key password before returning the error.

The bridge `auth-state` command verifies the persisted browser-fork key
password without contacting Proton. It reports `ready` only when the session is
locally valid and the configured key password is readable; otherwise it reports
a closed state such as `needs_data_password`.

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
