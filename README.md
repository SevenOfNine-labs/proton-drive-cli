# Proton Drive CLI

End-to-end encrypted CLI for Proton Drive with Git LFS bridge support, powered
by the official `@protontech/drive-sdk`.

## Installation

Requires Node.js 22+. The vendored Proton SDK must be built once first:

```bash
corepack enable
yarn install
(cd submodules/sdk/client/js && npm install --no-package-lock && npm run build)
yarn build
```

For local development, invoke the CLI directly with `node dist/index.js`.

## Authentication

Account authentication is browser-fork only: the account password is entered
on Proton's sign-in page and never reaches the CLI. The flow, polling
schedule, key unlock and token refresh send the same requests as the official
Proton account module (`submodules/sdk/incubating/account/js`), which a test
runs side by side with this CLI; the deliberate deviations are listed in
[Browser-Fork Authentication](docs/architecture/browser-fork-auth.md#deviations-from-the-official-module).

```bash
proton-drive-cli login
proton-drive-cli login --credential-store git-credential
proton-drive-cli status
proton-drive-cli logout
```

The login command opens Proton's browser sign-in flow and saves the session
tokens and the browser-derived key password, which unlocks the account keys of
every account type, as one entry per session in the credential store:
`pass-cli` by default, or `git-credential` through a git credential helper
that encrypts secrets at rest (osxkeychain, wincred, libsecret or Git
Credential Manager). `~/.proton-drive-cli/session.json` holds no secret, only
where the entry lives. See [Credential Security](docs/security/credentials.md).

## Offline Readiness

Run doctor before transfers or any guarded canary:

```bash
proton-drive-cli doctor
proton-drive-cli doctor --json
```

`doctor` and `bridge auth-state` are local checks: they never refresh tokens or
send a request to the Proton API. The credentials check reads the session's
entry from its credential store, and `pass-cli` can contact Proton Pass to do so.

## File Operations

```bash
proton-drive-cli ls /
proton-drive-cli upload ./file.pdf /Documents
proton-drive-cli download /Documents/file.pdf ./file.pdf
proton-drive-cli mkdir /Documents Projects
proton-drive-cli info /Documents/file.pdf
proton-drive-cli cat /Documents/file.txt
proton-drive-cli mv /Documents/old.pdf /Documents/new.pdf
proton-drive-cli rm /Documents/old.pdf
```

All file operations require a ready browser-fork session.

## Bridge Protocol

The bridge is for Git LFS adapter subprocess use. Each invocation reads one
JSON request object from stdin and writes exactly one JSON envelope line to
stdout; logs go to stderr.

```bash
printf '{}\n' | proton-drive-cli bridge auth-state
printf '{"oid":"<64 hex chars>","path":"/tmp/object.bin"}\n' | proton-drive-cli bridge upload
```

Supported commands are `auth-state`, `init`, `upload`, `download`, `exists`,
`batch-exists`, `delete`, `batch-delete` and `list`. No request field carries
a secret, and a request with an unknown field is rejected before any command
runs.

The contract is published as JSON Schema (draft 2020-12) under
`schemas/bridge/v1/` and validated against real command output by the test
suite:

| File | Describes |
| --- | --- |
| `request.schema.json` | The stdin request object |
| `request-field-rules.json` | Required/allowed request fields per command (data file; shape in `request-field-rules.schema.json`) |
| `response-envelope.schema.json` | The stdout envelope: `{ ok: true, payload }` or `{ ok: false, error, code, details }` |
| `payloads/<command>.schema.json` | The `payload` object of each command |
| `auth-state-payload.schema.json` | The `auth-state` payload (also read by the Go adapter contract test) |
| `error-details.schema.json` | The JSON object encoded in `details`; `errorCode` is always present |
| `error-code-map.json` | `errorCode` → HTTP-like `code` and Go adapter error code (data file; shape in `error-code-map.schema.json`) |

`schemas/doctor/v1/report.schema.json` describes `proton-drive-cli doctor --json`.

Field-by-field descriptions: [docs/reference/bridge-protocol.md](docs/reference/bridge-protocol.md)
and [docs/reference/doctor.md](docs/reference/doctor.md).

## Global Options

| Flag | Description |
| --- | --- |
| `-d, --debug` | Enable debug output with stack traces |
| `--verbose` | Show detailed output |
| `-q, --quiet` | Suppress non-error output |
| `-v, --version` | Display version number |

## Testing

```bash
yarn build
yarn test --runInBand
```

All default tests are mocked/offline and CI-safe. Real Proton validation must
use the separate guarded canary process from the parent `proton-lfs-cli` repo.

## License

MIT
