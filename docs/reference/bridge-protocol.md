# Bridge Protocol Reference

`proton-drive-cli bridge <command>` is the interface the Git LFS adapter
(`proton-lfs-cli`) uses. One invocation reads one JSON request object from
stdin, performs one operation with the saved browser-fork session, and writes
exactly one JSON envelope line to stdout. The contract is published as JSON
Schema under `schemas/bridge/v1/` (served at
`https://sevenofnine-labs.github.io/proton-drive-cli/schemas/`) and checked
against real command output by `src/cli/bridge.test.ts` and
`src/bridge/schemas.test.ts`. Source of truth: `src/bridge/protocol.ts`,
`src/bridge/validators.ts`, `src/cli/bridge.ts`.

Contract version: `1` (`contractVersion` in `error-code-map.json`).

## Invocation

```bash
printf '{}\n' | proton-drive-cli bridge auth-state
printf '{"oid":"<64 hex>","path":"/tmp/object.bin"}\n' | node dist/index.js bridge upload
```

| Aspect | Rule |
| --- | --- |
| stdin | The whole input is read and parsed as one JSON object; the caller must close stdin. After 30 s without end of input the command fails with `VALIDATION_ERROR` |
| stdout | Exactly one line: the envelope. Nothing else is written to stdout |
| stderr | Logs, at ERROR level unless `DEBUG=true` is set in the environment |
| Exit status | `0` when an envelope was written (inspect `ok`); `1` when the request could not be read (timeout, empty input, invalid JSON); an error envelope is still written |
| Command name | Case-insensitive; an unknown name yields a 400 `VALIDATION_ERROR` envelope |
| Account login | Never. Every command reuses `~/.proton-drive-cli/session.json`; `auth-state` is offline, the others initialize the SDK client from the saved session |

## Request fields

`request.schema.json` lists every field; `request-field-rules.json` says which
each command requires and accepts. A request with any other field, a known
field a command does not accept, a non-string value (`oids` must be an array
of strings), or a missing required field is rejected with a 400
`VALIDATION_ERROR` envelope before credentials, the network or the local
filesystem are touched. Account-login fields such as `username`, `password`,
`allowLogin` or `credentialProvider` are therefore rejected as unknown fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `dataCredentialProvider` | string | Provider of the mailbox/data password of a two-password account: `pass-cli` or `git-credential` (aliases `pass`, `git`) |
| `dataCredentialHost` | string | Host/key of that entry; default `proton-data.proton-lfs-cli.local` |
| `appVersion` | string | Override of the `x-pm-appversion` identity; must match `external-drive-{name}@{major.minor.patch}` with an optional `-stable`, `-beta` or `-alpha` channel and `+build` suffix, or the command fails before any network call |
| `storageBase` | string | Base folder of the OID tree; default `LFS`; leading and trailing slashes are stripped |
| `oid` | string | Git LFS object id, 64 hex characters (case-insensitive; lower-cased in paths) |
| `path` | string | Local file to upload |
| `outputPath` | string | Local file to write the download to |
| `folder` | string | Drive folder to list; default `/<storageBase>` |
| `oids` | string array | Object ids for the batch commands |

Local paths must not contain a null byte or a `..` segment.

### Fields per command

Common fields `dataCredentialProvider`, `dataCredentialHost`, `appVersion`
and `storageBase` are accepted by every command.

| Command | Required | Also accepted |
| --- | --- | --- |
| `auth-state` | none | common only |
| `init` | none | common only |
| `exists` | `oid` | — |
| `upload` | `oid`, `path` | — |
| `download` | `oid`, `outputPath` | — |
| `delete` | `oid` | — |
| `list` | none | `folder` |
| `batch-exists` | `oids` | — |
| `batch-delete` | `oids` | — |

## Envelope

`response-envelope.schema.json`:

```json
{"ok":true,"payload":{...}}
{"ok":false,"error":"<message>","code":<HTTP-like status>,"details":"<JSON object as a string>"}
```

A success carries `payload` and nothing else; a failure carries `error`
(non-empty), `code` (the status from the error-code map) and `details` (a
JSON-encoded object, see [Error details](#error-details)). The adapter
rejects any other shape.

## Commands and payloads

Object layout in Drive: `/<storageBase>/<oid[0:2]>/<oid[2:4]>/<oid>`
(`oidToPath` in `src/bridge/validators.ts`).

### auth-state

Local-only readiness of the saved session: reads `session.json`, applies the
local expiry checks, and verifies that the browser-fork key password can be
read back from its provider. No network request, no account credential
lookup. Payload (`auth-state-payload.schema.json`):

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | enum | `ready`, `needs_login`, `needs_data_password`, `needs_key_password`, `session_expired`, `session_invalid`, `configuration_error` |
| `hasSession` | bool | A session file was loaded |
| `sessionValid` | bool | The local expiry checks passed |
| `sessionExpired` | bool | `hasSession` and not `sessionValid` |
| `sessionUidPresent` | bool | The session carries a UID |
| `passwordMode` | int | Proton password mode of the session (1 single, 2 two-password) |
| `authMode` | enum | `browser-fork` |
| `keyPasswordPersisted` | bool | The session records a stored key password |
| `keyPasswordAvailable` | bool | The key password was read back from the provider during this call |
| `keyPasswordProvider`, `keyPasswordHost` | string | Provider and host recorded in the session |
| `dataCredentialProvider`, `dataCredentialHost` | string | Normalized values from the request (host defaults when a provider is given) |
| `willAttemptNetwork` | const false | Always false; the adapter refuses a payload that says otherwise |
| `errors` | string array | Why the state is not `ready` (for example an unknown provider name) |
| `actions` | string array | Human-readable next steps |

How `state` is chosen, first match wins:

| Condition | `state` |
| --- | --- |
| A provider name in the request is unknown | `configuration_error` |
| No session file | `needs_login` |
| Local expiry check failed | `session_expired` when a session exists and is expired, `session_invalid` otherwise |
| `passwordMode` is neither 1 nor 2 | `session_invalid` |
| Browser-fork session whose key password is not readable, and no `dataCredentialProvider` | `needs_key_password` |
| Session not created by browser-fork, and no `dataCredentialProvider` | `needs_data_password` |
| otherwise | `ready` |

### init

Creates `/<storageBase>` (whole chain) if missing.
Payload: `{"storageBase":"LFS","path":"/LFS","initialized":true}`.

### exists

Payload: `{"oid":"<oid>","exists":true|false}`. No other field is ever
present; the adapter parses it strictly.

### upload

Uploads `path` to the OID location. When the object already exists remotely
nothing is transferred and `deduplicated` is true. The transfer is retried up
to three times with 1 s to 5 s backoff.
Payload: `{"oid":"<oid>","fileId":"<node uid>","revisionId":"<revision uid or empty>","uploaded":true|false,"deduplicated":true|false}`.

### download

Writes the object to `outputPath` (created with mode `0600`, recreated on
retry) and reports the flushed size. A missing object is a 404
`FILE_NOT_FOUND` envelope.
Payload: `{"oid":"<oid>","outputPath":"<path>","size":<bytes>,"downloaded":true}`.

### delete

Deletes the object; a missing object is a 404 `FILE_NOT_FOUND` envelope, never
a success. Payload: `{"oid":"<oid>","deleted":true}`.

### list

Lists the direct children of `folder` (default `/<storageBase>`).
Payload: `{"files":[{"name":"…","type":"file"|"folder","size":<bytes>,"modifiedTime":<unix seconds, 0 when unknown>}]}`.

### batch-exists and batch-delete

One boolean per requested OID, keyed by the OID exactly as sent:
`{"results":{"<oid>":true,"<oid>":false}}`. For `batch-delete`, `false` means
the object did not exist. These are maintenance helpers for the adapter's
tests and canaries, not part of the Git LFS transfer loop.

## Error details

`details` is a JSON-encoded object (`error-details.schema.json`).
`errorCode` is always present and is one of the keys of the error-code map;
the other fields appear when the failure carries them, and further redacted
`AppError` details (`statusCode`, `apiError`, `sdkError`, ...) may be
included.

| Field | Type | When |
| --- | --- | --- |
| `errorCode` | enum | always |
| `twoFactorType` | `totp` or `fido2` | `TWO_FACTOR_REQUIRED` |
| `totpAllowed`, `fido2Available` | bool | `TWO_FACTOR_REQUIRED` |
| `captchaUrl`, `captchaToken`, `verificationMethods` | string, string, string array | `CAPTCHA_REQUIRED` |
| `action` | string | Guidance, for example `run: proton-drive-cli login` or `stop: app/session scope is insufficient; do not retry login loops` |
| `retryAfter` | number | `RATE_LIMITED`, seconds; the message becomes `Rate limited by Proton API — wait <n>s and retry` |
| `protonCode` | number | Proton API code when known; `9101` for `INSUFFICIENT_SCOPE` |

## Error codes

`error-code-map.json` fixes, for every `errorCode`, the envelope `code` the
bridge emits (`ERROR_CODE_STATUS` in `src/bridge/protocol.ts`) and the root
code the Go adapter writes to its status file.

| `errorCode` | `code` | Adapter root code |
| --- | --- | --- |
| `AUTH_FAILED`, `SESSION_EXPIRED`, `INVALID_CREDENTIALS` | 401 | `auth_required` |
| `TWO_FACTOR_REQUIRED` | 401 | `two_factor_required` |
| `DATA_PASSWORD_REQUIRED` | 401 | `data_password_required` |
| `KEY_PASSWORD_REQUIRED` | 401 | `key_password_required` |
| `INSUFFICIENT_SCOPE` | 403 | `insufficient_scope` |
| `PERMISSION_DENIED` | 403 | `permission_denied` |
| `NOT_FOUND`, `FILE_NOT_FOUND`, `PATH_NOT_FOUND` | 404 | `not_found` |
| `CAPTCHA_REQUIRED` | 407 | `captcha_required` |
| `FILE_TOO_LARGE` | 413 | `invalid_request` |
| `INVALID_FILE`, `INVALID_PATH`, `NOT_A_FOLDER`, `VALIDATION_ERROR` | 400 | `invalid_request` |
| `OPERATION_CANCELLED` | 499 | `invalid_request` |
| `RATE_LIMITED` | 429 | `rate_limited` |
| `NETWORK_ERROR`, `CONNECTION_REFUSED` | 502 | `network_failure` |
| `TIMEOUT` | 504 | `network_failure` |
| `API_ERROR`, `UPLOAD_FAILED`, `DOWNLOAD_FAILED` | 502 | `server_error` |
| `QUOTA_EXCEEDED`, `DISK_FULL` | 507 | `server_error` |
| `ENCRYPTION_FAILED`, `DECRYPTION_FAILED`, `UNKNOWN_ERROR` | 500 | `server_error` |

## Environment

The bridge reads `PROTON_PASS_CLI_BIN`, `PROTON_KEY_PASSWORD_PROVIDER`,
`PROTON_KEY_PASSWORD_HOST`, `PROTON_DRIVE_CLI_APP_VERSION`,
`PROTON_AUTH_TRACE`, `PROTON_AUTH_TRACE_ID` and `DEBUG`; see
[Configuration](../operations/configuration.md). The Go adapter forwards
only an allowlist of variables to the subprocess and bounds every command
with its own timeout (default 5 minutes plus one second per 256 KiB for
transfers).
