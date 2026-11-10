# Proton Drive CLI

End-to-end encrypted CLI for Proton Drive with Git LFS bridge support, powered
by the official `@protontech/drive-sdk`. It is the storage backend of
[proton-lfs-cli](https://github.com/SevenOfNine-labs/proton-lfs-cli) and is
pre-alpha: command output and the bridge contract can change between minor
versions.

Documentation: <https://sevenofnine-labs.github.io/proton-drive-cli/>.
Release notes and upgrade steps: [GitHub Releases](https://github.com/SevenOfNine-labs/proton-drive-cli/releases).

## Installation

Each [GitHub Release](https://github.com/SevenOfNine-labs/proton-drive-cli/releases)
carries single executables that need no Node.js:
`proton-drive-cli-darwin-arm64`, `proton-drive-cli-linux-amd64` and
`proton-drive-cli-windows-amd64.exe`. Check the download against the
release's `SHA256SUMS.txt`, then install it as `proton-drive-cli` on your
`PATH`:

```bash
sha256sum -c --ignore-missing SHA256SUMS.txt   # shasum -a 256 -c on macOS
install -m 0755 proton-drive-cli-linux-amd64 ~/.local/bin/proton-drive-cli
```

The macOS executable is ad-hoc signed, not notarized: clear the quarantine
attribute once with `xattr -d com.apple.quarantine <file>`. On Windows,
check `Get-FileHash proton-drive-cli-windows-amd64.exe` against
`SHA256SUMS.txt` and put the file on `PATH` as `proton-drive-cli.exe`.

### Platforms

| Executable | Runs on |
| --- | --- |
| `proton-drive-cli-darwin-arm64` | macOS 13.5 or later on Apple silicon |
| `proton-drive-cli-linux-amd64` | Linux x86-64 with glibc 2.28 or later |
| `proton-drive-cli-windows-amd64.exe` | Windows 10 or later, x64 |

The executables embed Node.js 26 and share its platform minimums. Other
platforms (Intel macOS, Linux arm64, musl, Windows on Arm) run the CLI from
source.

### From source

Requires Node.js 22 or later and Git. Yarn 4 comes from Corepack; Node.js 25
and later ship without it, so install it with npm there. The vendored Proton
SDK must be built once first:

```bash
git submodule update --init --depth 1 submodules/sdk
npm install -g corepack   # Node.js 25 or later
corepack enable
yarn install
(cd submodules/sdk/client/js && npm install --no-package-lock && npm run build)
yarn build
```

For local development, invoke the CLI directly with `node dist/index.js`.
`bash scripts/build-sea.sh` builds the single executable into `bin/` with
the Node.js version in `.node-version`.

## Before You Sign In

`login` saves the session in a credential store, which must be ready first.

- **pass-cli** (default): install the
  [Proton Pass CLI](https://protonpass.github.io/pass-cli/get-started/installation/)
  and run `pass-cli login`. On Linux, pass-cli keeps its local key in the
  kernel keyring by default, which a reboot clears and a login session with
  its own session keyring (keyrings(7), such as an SSH login) cannot see;
  pass-cli then logs itself out and transfers fail with
  `credentials_unavailable`. Set `PROTON_PASS_LINUX_KEYRING=dbus` (Secret
  Service) in every environment that runs pass-cli, before `pass-cli login`
  ([pass-cli key storage](https://protonpass.github.io/pass-cli/get-started/configuration/#secure-key-storage)).
  Without a Secret Service, `PROTON_PASS_KEY_PROVIDER=fs` keeps the key in a
  plain file next to the encrypted data, which pass-cli documents as less
  secure.
- **git-credential**: configure a git credential helper that encrypts at
  rest for the credential host (git 2.26 or later), then log in with
  `--credential-store git-credential`:

  ```bash
  git config --global 'credential.https://proton-drive-cli.invalid.helper' osxkeychain   # or wincred, libsecret, manager
  ```

`login` checks the store before it opens the browser and stops with the
store's reason when the session could not be saved.

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

## Troubleshooting

| Reported by `doctor`, `auth-state` or an error | Fix |
| --- | --- |
| `needs_login`, `session_invalid` | `proton-drive-cli login` |
| `credentials_unavailable` | Fix the store named in the error (for example `pass-cli login`), or log in again |
| `session_expired` | Nothing: the next transfer refreshes the token; `proton-drive-cli session refresh` does it at once |
| `RATE_LIMITED` | Wait until the time in the error; every process honours the shared cooldown (`~/.proton-drive-cli/rate-limit-cooldown.json`) |

`--debug` prints the error code and details; `doctor --json` is the report
to attach to an issue (it holds no secret).

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

## Known Limitations

- Production Proton endpoints only (`drive-api.proton.me`,
  `account.proton.me`).
- Transfers are not resumed: an interrupted transfer starts over.
- One Proton session per operating-system user: `login` replaces it.
- The macOS executable is not notarized.

## Testing

```bash
yarn build
yarn test --runInBand
```

All default tests are mocked/offline and CI-safe. Real Proton validation must
use the separate guarded canary process from the parent `proton-lfs-cli` repo.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities as described
in [SECURITY.md](SECURITY.md).

## License

[MIT](https://github.com/SevenOfNine-labs/proton-drive-cli/blob/main/LICENSE)
