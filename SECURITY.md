# Security Policy

For detailed credential flows, trust boundaries, and threat mitigations, see [docs/security/credentials.md](docs/security/credentials.md).

## Key Principles

- **Account login is browser-fork only.** `proton-drive-cli login` opens Proton's browser sign-in; the account password never reaches the CLI.
- **Passwords are never persisted to disk.** `~/.proton-drive-cli/session.json` holds revocable session tokens and browser-fork metadata only (`0600`, directory `0700`).
- **The browser-derived key password lives in a credential provider.** It is stored UID-scoped under `proton-drive-key.proton-lfs-cli.local` in `pass-cli` (default) or `git-credential`, verified by readback before a session is saved, and removed on logout, on a rejected refresh token and when a new login replaces the session UID. It is the only secret the CLI stores.
- **No secret travels through the environment, a command line or a bridge request.** The CLI reads no password from any of them.
- **The bridge is session-only.** `bridge auth-state` sends no Proton API request, every other bridge command reuses the saved session, and requests with unknown fields are rejected before any handler runs.
- **All encryption happens locally** before upload via `@protontech/drive-sdk`.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/SevenOfNine-labs/proton-drive-cli/security/advisories/new) rather than opening a public issue.
