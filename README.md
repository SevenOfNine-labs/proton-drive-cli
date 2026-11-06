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

Account authentication is browser-fork only. The CLI never accepts the Proton
account password through flags, stdin, environment variables, bridge JSON, or
credential-provider lookup.

```bash
proton-drive-cli login
proton-drive-cli login --key-password-provider git-credential
proton-drive-cli status
proton-drive-cli logout
```

The login command opens Proton's browser sign-in flow and stores only session
tokens in `~/.proton-drive-cli/session.json`. The browser-derived key password
is stored under a UID-scoped entry in the configured key-password provider
(`pass-cli` by default, `git-credential` on request).

## Offline Readiness

Run doctor before transfers or any guarded canary:

```bash
proton-drive-cli doctor
proton-drive-cli doctor --json
```

`doctor` and `bridge auth-state` are local-only checks. They do not perform SRP
login, token refresh, remote validation, or credential resolution for account
passwords.

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

All file operations require a ready browser-fork session. Two-password accounts
may also require an explicit data-password source configured by the caller.

## Bridge Protocol

The bridge is for Git LFS adapter subprocess use. Each invocation reads one
JSON request object from stdin and writes exactly one JSON envelope line to
stdout; logs go to stderr.

```bash
printf '{}\n' | proton-drive-cli bridge auth-state
printf '{"oid":"<64 hex chars>","path":"/tmp/object.bin"}\n' | proton-drive-cli bridge upload
```

Supported commands are `auth-state`, `init`, `upload`, `download`, `exists`,
`batch-exists`, `delete`, `batch-delete` and `list`. Request fields that
would carry account-login data (`username`, `password`, `allowLogin`,
`credentialProvider`) are rejected before any command runs; a mailbox/data
password is reached only through `dataCredentialProvider` and
`dataCredentialHost`.

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
