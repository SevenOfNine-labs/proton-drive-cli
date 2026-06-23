# Proton Drive CLI

End-to-end encrypted CLI for Proton Drive with Git LFS bridge support, powered
by the official `@protontech/drive-sdk`.

## Installation

```bash
corepack enable
yarn install
yarn build
```

For local development, invoke the CLI directly with `node dist/index.js`.

## Authentication

Account authentication is browser-fork only. The CLI never accepts the Proton
account password through flags, stdin, environment variables, bridge JSON, or
credential-provider lookup.

```bash
proton-drive-cli login
proton-drive-cli login --key-password-provider pass-cli
proton-drive-cli status
proton-drive-cli logout
```

The login command opens Proton's browser sign-in flow and stores only session
tokens in `~/.proton-drive-cli/session.json`. The browser-derived key password
is stored under a UID-scoped entry in the configured key-password provider.

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

The bridge is for Git LFS adapter subprocess use:

```bash
printf '%s\n' '{"command":"auth-state"}' | proton-drive-cli bridge auth-state
```

Supported commands are `auth-state`, `upload`, `download`, `list`, `exists`,
`delete`, `refresh`, `init`, `batch-exists`, and `batch-delete`. The removed
`auth` command and legacy login-shaped request fields are rejected.

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
