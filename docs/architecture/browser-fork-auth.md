# Browser Fork Authentication

## Flow

`proton-drive-cli login` is the only way to create a session. It follows the
official Proton account module
(`submodules/sdk/incubating/account/js/src/auth.ts` `authViaWeb` and
`authWeb.ts`):

1. Start a fork with unauthenticated `GET /auth/v4/sessions/forks`.
2. Generate an `account.proton.me/desktop/login?app=drive&pv=3` URL with a
   fragment payload containing the user code, a random 32-byte AES key, and
   the auth client id.
3. Open the URL for the user, wait 5 s (`FORK_INITIAL_DELAY_MS`), then poll
   `GET /auth/v4/sessions/forks/:selector` every 5 s
   (`FORK_POLL_INTERVAL_MS`) for at most 10 minutes
   (`FORK_MAX_POLL_TIME_MS`).
4. Treat HTTP 422 as "not approved yet".
5. Decrypt the returned payload with AES-256-GCM (NIST SP 800-38D) using AAD
   `fork`; it carries the user key password.
6. Persist the tokens in `session.json` and the key password in the
   key-password provider.

Every request carries `x-pm-appversion` and
`x-pm-drive-sdk-version: js@<vendored SDK release>`, as the official
`ApiClient` does (`apiClient.ts`, `cli/src/api/index.ts`).

## Safety Contract

The fork payload contains `keyPassword`, which is needed to unlock Proton user
keys for Drive operations. Proton's official CLI stores that secret in an OS
secret store. This project stores the derived key password in a configured
credential provider and verifies readback before saving the browser-fork
session. The secret is never written to `~/.proton-drive-cli/session.json`.

Key-password provider selection is explicit:

- `--key-password-provider <pass-cli|git-credential>` wins.
- `PROTON_KEY_PASSWORD_PROVIDER` is used when the flag is absent; otherwise
  the default is `pass-cli`.
- `--key-password-host` or `PROTON_KEY_PASSWORD_HOST` can override the default
  `proton-drive-key.proton-lfs-cli.local` credential host.

The session file records where the key password lives:

```json
{
  "uid": "…",
  "accessToken": "…",
  "refreshToken": "…",
  "scopes": ["…"],
  "keyPasswordProvider": "pass-cli",
  "keyPasswordHost": "proton-drive-key.proton-lfs-cli.local",
  "tokenExpiresAt": 1893456000000
}
```

A `session.json` without a non-blank `uid`, `accessToken`, `refreshToken`,
`keyPasswordProvider` (`pass-cli` or `git-credential`) or `keyPasswordHost`
is not a login session: transfers
fail closed and `bridge auth-state` reports `session_invalid` until the next
login.

If key-password storage fails, or reading the entry back does not return the
same key password, the login command does not save the session and revokes
the new server session. If session save fails after key-password storage, it
removes the stored key password and revokes the new session before returning
the error. The previous session is read and replaced under the session lock;
when it has another UID, its key-password entry is removed and the server
session revoked after the save (failures are logged).

## Key Unlock

Transfers unlock the account keys with the stored key password only, as the
official `Addresses.getUserData` and `getAddressKey` do (`addresses.ts`):
every user key is decrypted with the key password; an address key with a
`Token` is decrypted with that token, which must decrypt with the user keys
and carry a valid user-key signature; an address key without a `Token` is
decrypted with the key password. A key password that opens no user key, or
that the credential provider cannot return, fails with `KEY_PASSWORD_REQUIRED`.

## Token Refresh

Refresh follows the official `ApiClient` (`apiClient.ts`
`refreshSessionIfPossible` and `performTokenRefresh`) except where
[Deviations](#deviations-from-the-official-module) says otherwise:

- `POST /auth/v4/refresh` with `x-pm-uid`, `Authorization: Bearer <rejected
  access token>` and the body
  `{"ResponseType":"token","GrantType":"refresh_token","RefreshToken":"…"}`; a
  response without `RefreshToken` or `UID` keeps the current value.
- A refresh starts only after an HTTP 401, or once when a command starts
  with an access token whose `tokenExpiresAt` has passed. Requests of one
  process rejected with the same access token share one refresh; a
  rate-limited or signed-out failure is reused for 30 seconds, any other
  failure lets the next request try again.
- The refresh runs under the session lock. After an HTTP 401 it is skipped
  when the session file already holds another access token than the rejected
  one, so concurrent processes never spend the single-use refresh token twice.
  A session file that holds another UID is never refreshed or adopted.
- The new tokens are written only while the session file still holds the
  refresh token that was spent, so a logout or sign-out during the request
  is never undone. That check also applies when proper-lockfile reports the
  lock compromised, so a refresh Proton already committed is never lost.
- A refresh the API rejects with a Proton error and HTTP 4xx other than 408
  (RFC 9110, 15.5.9) and 429, or answers with another UID, while the session
  file still holds that refresh token, signs out: `session.json`, the crypto
  cache and the key-password entry are removed and the command fails with
  `SESSION_EXPIRED`. After a compromised lock the session is kept instead.
- A refresh that fails for another reason keeps its own code
  (`NETWORK_ERROR`, `RATE_LIMITED`, `API_ERROR`, and `TIMEOUT` for a session
  lock another process holds, proper-lockfile `ELOCKED`) on every path,
  Drive transfers included, and leaves the session in place. A refresh
  answer with another UID is revoked (`DELETE /auth/v4`) before the sign-out.

## Logout

`proton-drive-cli logout` revokes the server session (`DELETE /auth/v4`,
after one refresh when the access token is rejected), removes its
key-password entry, then deletes `session.json` and the crypto cache under
the session lock unless a new login replaced them meanwhile. A session
already ended elsewhere is signed out by that refresh. An invalid session file
is deleted without a request.

## Deviations from the Official Module

| Behaviour | Official account module | This CLI | Reason |
| --- | --- | --- | --- |
| Sign-out after a failed refresh | Every HTTP 4xx except 429 (`performTokenRefresh`) | HTTP 4xx except 408 and 429, with a Proton error body | The sign-out deletes files and the key-password entry and can start from the tray's background refresh; 408 is retryable (RFC 9110, 15.5.9) and a proxy's error page is not Proton's verdict |
| Refresh response with another UID | Adopts the new UID | Signs the session out | The key-password entry and crypto cache are keyed by the UID |
| Logout | Clears local state (`Auth.logout`) | Also revokes the server session (`DELETE /auth/v4`) | A discarded session stays valid on the server until it expires |
| Locally expired access token | Refreshed on the next HTTP 401 | Refreshed once when a command starts | `tokenExpiresAt` is known and a command needs the account keys first |
| Session and key-password storage | OS secret store | `session.json` (0600) and the key password in pass-cli or git-credential | Bridge subprocesses share one session; see [Credentials](../security/credentials.md) |
| Concurrent processes | One process | Session lock, compare-and-swap writes, shared refresh per process | Git LFS starts one bridge process per transfer |
| Telemetry preference | `GET /core/v4/settings` after login | Not requested | This CLI sends no telemetry |

## Readiness

The bridge `auth-state` command reads the stored key password from the
session's credential provider without sending a request to the Proton API;
`pass-cli` can contact Proton Pass to do so. It reports `ready` only when the session
is locally valid and its key password is readable; otherwise it reports
`needs_login`, `session_invalid`, `session_expired` (which `bridge init`
refreshes before use) or `needs_key_password`.

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
