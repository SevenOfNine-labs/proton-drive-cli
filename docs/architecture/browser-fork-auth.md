# Browser Fork Authentication

## Flow

`proton-drive-cli login` is the only way to create a session. It follows the
official Proton account module
(`submodules/sdk/incubating/account/js/src/auth.ts` `authViaWeb` and
`authWeb.ts`):

1. Check the chosen credential store without writing to it: `pass-cli info`
   must succeed and the account must own or be allowed to edit a vault; for
   `git-credential`, git's configuration must name a helper that encrypts
   secrets at rest (the helper itself is not run, so a helper that fails
   when called still fails after the sign-in). A failed check ends the login
   with `CREDENTIALS_UNAVAILABLE` before the browser opens.
2. Start a fork with unauthenticated `GET /auth/v4/sessions/forks`.
3. Generate an `account.proton.me/desktop/login?app=drive&pv=3` URL with a
   fragment payload containing the user code, a random 32-byte AES key, and
   the auth client id.
4. Print the URL (unless `--quiet`) and open it in the default browser with
   the `open` package (open(1) on macOS, PowerShell `Start` on Windows and on
   WSL outside SSH sessions and containers, xdg-open(1) otherwise), then
   report whether that worked; under `--quiet` a browser that did not open
   fails the login at once (`AUTH_FAILED`, `details.reason`
   `browser-not-opened`). Wait 5 s (`FORK_INITIAL_DELAY_MS`), then poll
   `GET /auth/v4/sessions/forks/:selector` every 5 s
   (`FORK_POLL_INTERVAL_MS`) for at most 10 minutes
   (`FORK_MAX_POLL_TIME_MS`). A sign-in not completed by then fails with
   `AUTH_FAILED`.
5. Treat HTTP 422 as "not approved yet".
6. Decrypt the returned payload with AES-256-GCM (NIST SP 800-38D) using AAD
   `fork`; it carries the user key password.
7. Save the tokens and the key password in the credential store and the
   non-secret session record in `session.json`.

Every request carries `x-pm-appversion` and
`x-pm-drive-sdk-version: js@<vendored SDK release>`, as the official
`ApiClient` does (`apiClient.ts`, `cli/src/api/index.ts`).

## Session Storage

The fork payload contains `keyPassword`, which unlocks the Proton user keys,
and the response carries the access and refresh tokens. RFC 6749 (10.4)
requires refresh tokens to be kept confidential in storage, and RFC 6819
(5.1.4.1.4, 4.1.3) asks clients to keep such secrets in an encrypted store
and access tokens under the same protection. Proton's official CLI stores
all three in one OS secret-store entry (`Bun.secrets`). This CLI stores them
the same way, as one entry per session in a credential store, and keeps only
non-secret data in `~/.proton-drive-cli/session.json` (mode 0600, directory
0700).

Credential store selection is explicit:

- `--credential-store <pass-cli|git-credential>` wins.
- `PROTON_CREDENTIAL_STORE` is used when the flag is absent; otherwise the
  default is `pass-cli`.
- `--credential-host` or `PROTON_CREDENTIAL_HOST` can override the default
  credential host `proton-drive-cli.invalid` (RFC 6761, 6.4: the name never
  resolves, so a credential helper that probes it reaches no server).

The entry's username is the session UID and its secret is the compact JSON
object (RFC 8259) `{"uid", "revision", "accessToken", "refreshToken",
"keyPassword"}`, at most 1280 characters so that Git's wincred helper, which
stores UTF-16, stays within `CRED_MAX_CREDENTIAL_BLOB_SIZE` (2560 bytes).
Every write is read back and compared before the session counts as saved. See
[Credentials](../security/credentials.md) for the stores and the helpers
git-credential accepts.

`session.json` records where the entry lives:

```json
{
  "uid": "…",
  "scopes": ["…"],
  "credentialStore": "pass-cli",
  "credentialHost": "proton-drive-cli.invalid",
  "revision": "6f1c2b9e-4d8a-4c2f-9a51-3b7e0d4c8f12",
  "tokenExpiresAt": 1893456000000
}
```

`revision` is a version 4 UUID (RFC 9562, 5.4) written into the entry and
into `session.json`: login and every refresh store the entry first and then
`session.json` with the new revision, both under the session lock. A process
reads the entry once per revision and reuses it until `session.json` names
another one.

A `session.json` without a non-blank `uid`, `credentialHost` and `revision`
and a `credentialStore` of `pass-cli` or `git-credential` is not a login
session: transfers fail closed and `bridge auth-state` reports
`session_invalid` until the next login.

If saving the entry fails, or reading it back does not return the same
secrets, the login command does not save the session, removes the entry and
revokes the new server session. The previous session is read and replaced
under the session lock; when it has another UID, its entry is read for the
revocation, removed, and the server session revoked after the save
(failures are logged).

## Key Unlock

Transfers unlock the account keys with the stored key password only, as the
official `Addresses.getUserData` and `getAddressKey` do (`addresses.ts`):
every user key is decrypted with the key password; an address key with a
`Token` is decrypted with that token, which must decrypt with the user keys
and carry a valid user-key signature; an address key without a `Token` is
decrypted with the key password. A key password that opens no user key, or
an entry the credential store cannot return, fails with
`CREDENTIALS_UNAVAILABLE`.

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
  when `session.json` holds another revision than the one the rejected token
  came from, and the session of that revision is read after the lock is
  released; otherwise the entry is read from the credential store under the
  lock, and the refresh is skipped when it already holds another access
  token than the rejected one. The entry read under the lock must carry the
  revision of `session.json`, so a stale entry never spends a refresh token.
  Concurrent processes therefore never spend the single-use refresh token
  twice, and a process whose revision is outdated reads the store only after
  the lock is released. Waiters wait for the lock for about two minutes. A
  session file that holds another UID is never refreshed or adopted.
- The new tokens are written only while `session.json` still holds the
  revision whose refresh token was spent, so a logout or sign-out during the
  request is never undone. That check also applies when proper-lockfile
  reports the lock compromised, so a refresh Proton already committed is
  never lost. When the store rejects the new entry after Proton rotated the
  token, the command fails with `CREDENTIALS_UNAVAILABLE`. An entry that
  names the revision of `session.json` as the one it replaces is the result
  of a refresh that stopped before `session.json` was written: the next
  refresh writes `session.json` for it and goes on with its tokens. An entry
  that still holds the spent refresh token makes the next refresh sign the
  session out.
- A refresh the API rejects with a Proton error and HTTP 4xx other than 408
  (RFC 9110, 15.5.9) and 429, or answers with another UID, while
  `session.json` still holds that revision, signs out: `session.json`, the
  crypto cache and the credential-store entry are removed and the command
  fails with `SESSION_EXPIRED`. After a compromised lock the session is kept
  instead.
- A refresh that fails for another reason keeps its own code
  (`NETWORK_ERROR`, `RATE_LIMITED`, `API_ERROR`, and `TIMEOUT` for a session
  lock another process holds, proper-lockfile `ELOCKED`) on every path,
  Drive transfers included, and leaves the session in place. A refresh
  answer with another UID is revoked (`DELETE /auth/v4`) before the sign-out.

## Logout

`proton-drive-cli logout` revokes the server session (`DELETE /auth/v4`,
after one refresh when the access token is rejected) with the tokens of its
entry, deletes `session.json` and the crypto cache under the session lock
unless a new login replaced them meanwhile, then removes the entry, so a
refresh in flight cannot leave a new entry behind. A session already ended
elsewhere is signed out by that refresh. When the entry cannot be read the
server session is not revoked and the local cleanup still runs; an entry
that cannot be removed is reported. An invalid session file is deleted
without a request.

## Deviations from the Official Module

| Behaviour | Official account module | This CLI | Reason |
| --- | --- | --- | --- |
| Sign-out after a failed refresh | Every HTTP 4xx except 429 (`performTokenRefresh`) | HTTP 4xx except 408 and 429, with a Proton error body | The sign-out deletes files and the credential-store entry and can start from the tray's background refresh; 408 is retryable (RFC 9110, 15.5.9) and a proxy's error page is not Proton's verdict |
| Refresh response with another UID | Adopts the new UID | Signs the session out | The credential-store entry and crypto cache are keyed by the UID |
| Logout | Clears local state (`Auth.logout`) | Also revokes the server session (`DELETE /auth/v4`) | A discarded session stays valid on the server until it expires |
| Locally expired access token | Refreshed on the next HTTP 401 | Refreshed once when a command starts | `tokenExpiresAt` is known and a command needs the account keys first |
| Session storage | One OS secret-store entry (`Bun.secrets`), or `pass` | One entry in pass-cli or a git credential helper that encrypts at rest; non-secret `session.json` (0600) | Node.js has no secret-store API; Git's credential helpers reach the OS stores with local-only persistence; see [Credentials](../security/credentials.md#direct-os-secret-store-access) |
| Concurrent processes | One process | Session lock, compare-and-swap writes, shared refresh per process | Git LFS starts one bridge process per transfer |
| Credential store check | None: the store is first written after the fork | Before the fork, without writing (`checkWritable`) | A logged-out pass-cli or a git configuration without an encrypting helper fails before the user signs in, instead of discarding the forked session |
| API and account hosts | `PROTON_DRIVE_BASE_URL`, account host derived from it (`config.ts` `accountUrlFromBaseUrl`) | `drive-api.proton.me` and `account.proton.me` | This CLI targets the production service only |
| Telemetry preference | `GET /core/v4/settings` after login | Not requested | This CLI sends no telemetry |

## Readiness

The bridge `auth-state` command reads the session's entry from its
credential store without sending a request to the Proton API; `pass-cli` can
contact Proton Pass to do so. It reports `ready` only when the session is
locally valid and its entry is readable; otherwise it reports `needs_login`,
`session_invalid`, `session_expired` (which `bridge init` refreshes before
use) or `credentials_unavailable`.

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
