# Security Policy

For detailed credential flows, trust boundaries, and threat mitigations, see [docs/security/credentials.md](docs/security/credentials.md).

## Key Principles

- **Passwords are never persisted to disk.** Only revocable session tokens are stored.
- **Passwords are never accepted via CLI flags or environment variables.** Use git-credential, pass-cli, or `--password-stdin` only.
- **SRP-6a authentication.** Passwords never leave the client — only SRP proofs are sent.
- **Server proof verification** uses constant-time comparison (`crypto.timingSafeEqual`).
- **All encryption happens locally** before upload via `@protontech/drive-sdk`.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/SevenOfNine-labs/proton-drive-cli/security/advisories/new) rather than opening a public issue.
