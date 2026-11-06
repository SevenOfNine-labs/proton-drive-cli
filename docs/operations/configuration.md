# Configuration

Source of truth: `src/constants.ts`, `src/auth/state-dir.ts`,
`src/credentials/`, `src/cli/*.ts`, `src/index.ts`.

## State Files

| Path | Permissions | Contents |
| --- | --- | --- |
| `~/.proton-drive-cli/` | `0700` | State directory |
| `~/.proton-drive-cli/session.json` | `0600` | Session written by `login`: `uid`, `accessToken`, `refreshToken`, `keyPasswordProvider`, `keyPasswordHost`, and `scopes` and `tokenExpiresAt` when the API reports them |
| `~/.proton-drive-cli/session.lock` | directory | `proper-lockfile` lock guarding refresh-token rotation across processes |
| `~/.proton-drive-cli/crypto-cache.json` | `0600` | Cached user and address records (armored, passphrase-protected keys) for the current session UID; expires after one hour |
| `~/.proton-drive-cli/rate-limit-cooldown.json` | `0600` | Local wait-until timestamp after a Proton rate limit |

No account password is written to disk. The browser-derived key password is
stored in the credential provider, keyed by the session UID, under
`proton-drive-key.proton-lfs-cli.local`. A refresh token the API rejects
signs the session out: `session.json`, the crypto cache and the key-password
entry are removed. A login that yields a new session UID removes the
key-password entry of the previous UID and revokes that session.

With `pass-cli`, `login` stores the entry in a vault the account owns; when it
owns none, as with a personal access token or an agent session, in a vault it
may edit (role Manager or Editor). An existing entry in another vault is
moved. Login fails when no vault qualifies.

## Environment Variables

| Variable | Default | Read by | Description |
| --- | --- | --- | --- |
| `PROTON_KEY_PASSWORD_PROVIDER` | `pass-cli` | `login` | Browser-fork key-password provider: `pass-cli` or `git-credential` (aliases `pass`, `git`); the `--key-password-provider` option wins. Later commands use the provider recorded in the session |
| `PROTON_KEY_PASSWORD_HOST` | `proton-drive-key.proton-lfs-cli.local` | `login` | Key-password credential host/key; `--key-password-host` wins. Later commands use the host recorded in the session |
| `PROTON_PASS_CLI_BIN` | `pass-cli` (on `PATH`) | `pass-cli` provider | Proton Pass CLI binary |
| `PROTON_DRIVE_CLI_APP_VERSION` | `external-drive-protonlfscli@<version>` (the package version) | every API call | Proton `x-pm-appversion` identity (every request also carries `x-pm-drive-sdk-version: js@<vendored SDK release>`); must match `external-drive-{name}@{major.minor.patch}` with an optional `-stable`, `-beta` or `-alpha` channel and `+build` suffix, `{name}` in lowercase letters and underscores; `cli-drive` is rejected. A bridge request's `appVersion` field takes precedence |
| `PROTON_DRIVE_CLI_BIN` | the running entry point | `doctor` | Entry point whose existence the doctor checks |
| `PROTON_AUTH_TRACE` | unset | auth flow | `1`, `true`, `yes` or `on` writes redacted `[AUTH_TRACE]` JSON lines to stderr |
| `PROTON_AUTH_TRACE_ID` | unset | auth flow | Correlation id included in those lines (the `proton-lfs-cli` tray sets `tray-<pid>-<nanoseconds>`) |
| `DEBUG` | unset | all commands | `true` enables stack traces, auth trace and bridge logs below ERROR level; `--debug` sets it |

No variable carries a secret; the CLI reads no password from the
environment.

## Global Options

| Option | Effect |
| --- | --- |
| `-d, --debug` | Sets `DEBUG=true` for the process |
| `--verbose` | Detailed output (spinners, session details) |
| `-q, --quiet` | Suppress all non-error output; takes precedence over `--verbose` |
| `-v, --version` | Print the package version |

## Command Options

| Command | Options |
| --- | --- |
| `login` | `--key-password-provider <pass-cli or git-credential>`, `--key-password-host <host>` |
| `logout` | none; revokes the session (`DELETE /auth/v4`, refreshing an expired access token once; a failure is reported as a warning, a session ended elsewhere is not), removes the key-password entry and deletes the session file and crypto cache unless a new login replaced them; an invalid session file is deleted without a request |
| `status` | none; prints the session UID, its scopes and whether the key password is stored |
| `session refresh` | `--json` for a machine-readable result (`ok`, `refreshed`, `state`, and on failure `errorCode`, `recoverable`, `statusCode`, `protonCode`, `protonError`, `retryAfter` for a rate limit, `action`); `recoverable` is false only when the session ended (`SESSION_EXPIRED`) |
| `doctor` | See [Doctor Reference](../reference/doctor.md) |
| `bridge <command>` | See [Bridge Protocol Reference](../reference/bridge-protocol.md) |
| `ls`, `upload`, `download`, `mkdir`, `rm`, `mv`, `cat`, `info` | `proton-drive-cli <command> --help` |

Exit status is `0` on success and `1` on failure for every command; `session
refresh` exits `0` when no session exists.

## Build and Development

The vendored Proton SDK (`submodules/sdk/client/js`) must be built once before
the CLI; upstream ships no npm lockfile, so use `npm install`:

```bash
corepack enable
yarn install
(cd submodules/sdk/client/js && npm install --no-package-lock && npm run build)
yarn build
yarn test --runInBand
```

Node.js 22 or newer is required to run `dist/index.js` (`engines.node`): the
SDK relies on `Array.fromAsync`, `Promise.withResolvers` and the `Uint8Array`
base64/hex helpers (the latter are polyfilled by `src/crypto/polyfill.ts` with
`core-js` on Node 22/24). CI runs the Jest suite on Node.js 22 and 26. The
single-executable build (`sea-config.json`, `node --build-sea`) needs Node.js
26, the version in the parent repository's `.node-version`.

## Offline Preflight

```bash
proton-drive-cli doctor
proton-drive-cli doctor --json
printf '{}\n' | proton-drive-cli bridge auth-state
```

These commands send no request to the Proton API and refresh no token; the
key-password check runs the session's credential provider, and `pass-cli` can
contact Proton Pass to read the entry.
