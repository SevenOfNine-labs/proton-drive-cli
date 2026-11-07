# Security Policy

For detailed credential flows, trust boundaries, and threat mitigations, see [docs/security/credentials.md](docs/security/credentials.md).

## Key Principles

- **Account login is browser-fork only.** `proton-drive-cli login` opens Proton's browser sign-in; the account password never reaches the CLI.
- **No secret is written to a file.** `~/.proton-drive-cli/session.json` holds the session UID, scopes, token expiry and where the session's credentials live (`0600`, directory `0700`).
- **Tokens and key password live in a credential store.** One entry per session UID under `proton-drive-cli.invalid` in `pass-cli` (default) or `git-credential`, the latter only through a helper that encrypts secrets at rest (osxkeychain, wincred, libsecret, Git Credential Manager). Every save is read back; the entry is removed on logout, on a rejected refresh token and when a new login replaces the session UID.
- **No secret travels through the environment, a command line or a bridge request.** The CLI reads no password from any of them.
- **The bridge is session-only.** `bridge auth-state` sends no Proton API request, every other bridge command reuses the saved session, and requests with unknown fields are rejected before any handler runs.
- **All encryption happens locally** before upload via `@protontech/drive-sdk`.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/SevenOfNine-labs/proton-drive-cli/security/advisories/new) rather than opening a public issue.
