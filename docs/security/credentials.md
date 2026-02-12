# Credential Security

## Trust Boundaries

```
┌─────────────────────────────────────────────┐
│  User's Machine (trusted)                   │
│                                             │
│  ┌──────────────┐   ┌───────────────────┐   │
│  │ pass-cli     │   │ git credential    │   │
│  │ (encrypted)  │   │ (system keychain) │   │
│  └──────┬───────┘   └──────┬────────────┘   │
│         │                  │                │
│         ▼                  ▼                │
│  ┌──────────────────────────────────────┐   │
│  │ proton-drive-cli (memory only)       │   │
│  │  • Password held in memory           │   │
│  │  • SRP handshake (password → proof)  │   │
│  │  • Key decryption (password → keys)  │   │
│  │  • Session tokens saved to disk      │   │
│  └──────────────┬───────────────────────┘   │
└─────────────────┼───────────────────────────┘
                  │ HTTPS (TLS)
                  ▼
         ┌────────────────┐
         │ Proton API     │
         │ (SRP proof     │
         │  only, never   │
         │  plaintext pw) │
         └────────────────┘
```

## Credential Providers

### git-credential (recommended for standalone use)

Delegates to the system credential helper via `git credential fill`:

- **macOS:** Keychain Access
- **Windows:** Windows Credential Manager
- **Linux:** GNOME Keyring / KWallet / Secret Service

```bash
proton-drive credential store -u your.email@proton.me
proton-drive login --credential-provider git
```

Credentials are resolved locally by `proton-drive-cli` — never sent over HTTP.

### pass-cli (Git LFS integration default)

Credentials flow through the proton-git-lfs stack:

```
pass-cli → Go adapter → proton-drive-cli bridge (stdin)
```

The Go adapter resolves `pass://` references and spawns `proton-drive-cli bridge` directly, passing credentials via stdin. Credentials are held in memory only.

### Piped stdin (scripted usage)

For environments where neither git-credential nor pass-cli is available:

```bash
printf '%s' 'password' | proton-drive login -u user@proton.me --password-stdin
```

Reads password from stdin with a 5-second timeout. No shell history exposure.

## What Is Never Allowed

| Vector                | Status   | Rationale                                          |
| --------------------- | -------- | -------------------------------------------------- |
| Password in CLI flags | Rejected | Visible via `ps aux`, `/proc/pid/cmdline`          |
| Password in env vars  | Rejected | Visible via `/proc/pid/environ`, child processes   |
| Password on disk      | Rejected | Only revocable session tokens are persisted        |
| Password in logs      | Rejected | Debug logging redacts credential fields            |

## Authentication Flow (SRP-6a)

1. Client sends username to Proton API, receives salt + server ephemeral
2. Client computes SRP proof from password (never sent to server)
3. Server verifies proof, returns server proof + session tokens
4. Client verifies server proof using `crypto.timingSafeEqual`
5. Session tokens saved to `~/.proton-drive-cli/session.json` (`0600`)
6. Password used to decrypt user mailbox keys (in memory), then discarded

## Session Management

- Session directory: `0700` (owner-only)
- Session file: `0600` (owner-only)
- Tokens refreshed automatically on HTTP 401 and Proton error code 9101
- `proton-drive logout` clears all session data

## Input Validation

- Path traversal: `..` and null bytes rejected in all path operations
- OID validation: `/^[a-f0-9]{64}$/i` enforced before any bridge operation
- Subprocess calls use `execFile` (not `exec`) to prevent shell injection
- Git credential host parameter validated before subprocess spawn
