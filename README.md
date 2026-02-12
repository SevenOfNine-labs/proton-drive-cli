# Proton Drive CLI

End-to-end encrypted CLI for Proton Drive with Git LFS bridge support, powered by the official `@protontech/drive-sdk`.

## Installation

```bash
corepack enable
yarn install
yarn build
```

For local development, invoke the CLI directly with `node dist/index.js`.

## Credential Providers

Passwords are never accepted via CLI flags or environment variables. This prevents leaks via `ps`, `/proc/pid/environ`, and shell history.

### Git Credential Manager (recommended)

Uses the system credential helper (macOS Keychain, Windows Credential Manager, Linux Secret Service) via `git credential fill`.

```bash
# Store credentials in the system credential helper
proton-drive credential store -u your.email@proton.me

# Verify credentials are stored
proton-drive credential verify

# Login using stored credentials
proton-drive login --credential-provider git

# Use with any command
proton-drive ls / --credential-provider git

# Remove stored credentials
proton-drive credential remove -u your.email@proton.me
```

### pass-cli (Git LFS integration)

When used through `proton-git-lfs`, the Go adapter resolves credentials via `pass-cli` and spawns `proton-drive-cli bridge` directly, passing credentials over stdin. Do not run `proton-drive login` manually in this mode.

```
pass-cli → Go adapter → proton-drive-cli bridge (stdin, memory only)
```

### Piped stdin (scripted usage)

For CI or scripted environments where git-credential is not available:

```bash
printf '%s' 'password' | proton-drive login -u user@proton.me --password-stdin
printf '%s' 'password' | proton-drive credential store -u user@proton.me --password-stdin
```

## Usage

### Authentication

```bash
# Login with git-credential (recommended)
proton-drive login --credential-provider git

# Login with piped password
printf '%s' 'your-password' | proton-drive login -u your.email@proton.me --password-stdin

# Check authentication status
proton-drive status

# Logout
proton-drive logout
```

Session tokens (no passwords) are stored in `~/.proton-drive-cli/session.json` with `0600` permissions. Tokens are refreshed automatically on HTTP 401 and Proton error code 9101.

**CAPTCHA:** If CAPTCHA verification is required during login, the CLI guides you through the semi-automated token extraction process.

### File Operations

```bash
# List files
proton-drive ls /
proton-drive ls /Documents --long

# Upload files
proton-drive upload ./file.pdf /Documents
cat data.json | proton-drive upload - /Documents --name data.json

# Download files
proton-drive download /Documents/file.pdf ./file.pdf

# Create folders
proton-drive mkdir /Documents Projects

# Show file/folder metadata
proton-drive info /Documents/file.pdf

# Stream file contents to stdout
proton-drive cat /Documents/file.txt

# Move or rename files/folders
proton-drive mv /Documents/old-name.pdf /Documents/new-name.pdf

# Remove files/folders
proton-drive rm /Documents/old-file.pdf
proton-drive rm /Documents/old-file.pdf --permanent
```

### Global Options

| Flag                    | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `-d, --debug`           | Enable debug output with full stack traces        |
| `--verbose`             | Show detailed output (spinners, progress, tables) |
| `-q, --quiet`           | Suppress all non-error output                     |
| `-v, --version`         | Display version number                            |
| `--credential-provider` | Credential source: `git` or default (stdin)       |

## Documentation

See `docs/` for detailed documentation:

- [Architecture](docs/architecture/overview.md) — Components, data flow, SDK adapter layer
- [Credential Security](docs/security/credentials.md) — Credential flows, threat model, trust boundaries
- [Configuration](docs/operations/configuration.md) — Environment variables, session management

When docs disagree, runtime behavior and tests win.

## Testing

```bash
yarn test                        # Run all tests (fully mocked)
yarn test --no-cache             # Without cache
npx jest src/sdk/                # SDK adapter tests only
npx jest src/cli/e2e.test        # E2E CLI tests
```

All tests are fully mocked and CI-safe — no Proton credentials required.

## License

MIT
