# Security Policy

For detailed credential flows, trust boundaries, and threat mitigations, see [docs/security/credentials.md](docs/security/credentials.md).

## Key Principles

- **Account login is browser-fork only.** `proton-drive-cli login` opens Proton's browser sign-in; the CLI never receives the account password through flags, stdin, environment variables, bridge JSON, or a credential-provider lookup.
- **Passwords are never persisted to disk.** `~/.proton-drive-cli/session.json` holds revocable session tokens and browser-fork metadata only (`0600`, directory `0700`).
- **The browser-derived key password lives in a credential provider.** It is stored UID-scoped under `proton-drive-key.proton-lfs-cli.local` in `pass-cli` (default) or `git-credential`, and verified by readback before a session is saved.
- **Secrets never travel through the environment.** `doctor` fails when `PROTON_DATA_PASSWORD` or `PROTON_SECOND_FACTOR_CODE` is set; a mailbox/data password is reached only through `dataCredentialProvider` / `dataCredentialHost`.
- **The bridge is session-only.** `bridge auth-state` is offline, every other bridge command reuses the saved session, and account-login request fields are rejected before any handler runs.
- **All encryption happens locally** before upload via `@protontech/drive-sdk`.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/SevenOfNine-labs/proton-drive-cli/security/advisories/new) rather than opening a public issue.
