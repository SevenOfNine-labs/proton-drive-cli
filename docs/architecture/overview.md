# Architecture Overview

## Components

```
proton-drive-cli
├── CLI layer        — Commander.js commands (login, ls, upload, download, bridge, credential)
├── SDK adapter      — Bridges @protontech/drive-sdk with Proton API
├── Auth service     — SRP-6a authentication with session management
├── Crypto service   — OpenPGP key management via @protontech/openpgp
└── Bridge protocol  — JSON stdin/stdout interface for Git LFS integration
```

## Data Flow

### Standalone Usage

```
User → CLI command → SDK adapter → Proton API
                         ↓
                   DriveCrypto (encrypt/decrypt locally)
```

### Git LFS Integration (pass-cli)

```
pass-cli (stored credentials)
    ↓
Go adapter (resolves via pass-cli, spawns proton-drive-cli directly)
    ↓
proton-drive-cli bridge (stdin: username + password)
    ↓
AuthService.login() → SRP handshake → Session tokens
    ↓
DriveCrypto.initialize(password) → Decrypt user keys
    ↓
ProtonDriveClient ready for upload/download
```

### Git LFS Integration (git-credential)

```
proton-drive-cli bridge (credentialProvider: "git-credential")
    ↓
gitCredentialFill() → git credential fill (local subprocess)
    ↓
Same auth flow as above (credentials never sent over HTTP)
```

## SDK Adapter Layer

The `src/sdk/` directory adapts `@protontech/drive-sdk` for CLI usage:

| Adapter                | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `httpClientAdapter.ts` | HTTP client with auto token refresh, `x-pm-appversion` header injection |
| `cryptoProxy.ts`       | OpenPGP crypto proxy for drive-sdk                                      |
| `accountAdapter.ts`    | Account and address key provider                                        |
| `srpAdapter.ts`        | SRP module adapter                                                      |
| `pathResolver.ts`      | Human-readable path to Proton Drive UID resolution                      |
| `client.ts`            | `ProtonDriveClient` factory with session reuse                          |

## Source Layout

```
src/
├── api/           — Proton API clients (auth, user)
├── auth/          — SRP-6a authentication and session management
│   └── srp/       — SRP protocol implementation
├── bridge/        — Shared types and validators for the bridge protocol
├── cli/           — Command implementations
├── crypto/        — OpenPGP key management, Drive crypto
├── errors/        — Error types, codes, CLI error handler
├── sdk/           — @protontech/drive-sdk adapter layer
├── types/         — TypeScript type definitions
└── utils/         — Logging, password handling, git-credential, validation
```

## Bridge Protocol

The `proton-drive bridge <command>` interface reads JSON from stdin and writes JSON to stdout using a `{ ok, payload, error, code }` envelope.

**Commands:** `auth`, `upload`, `download`, `list`, `exists`, `delete`, `refresh`, `init`, `batch-exists`, `batch-delete`

**Request format:**

```json
{
  "username": "...",
  "password": "...",
  "credentialProvider": "git-credential",
  "oid": "<64-hex>",
  "path": "./file",
  "outputPath": "./out"
}
```

Credentials are resolved from `username`/`password` fields, or locally via `gitCredentialFill()` when `credentialProvider` is set.

## Non-Negotiables

- All crypto operations use `@protontech/openpgp` (not plain `openpgp`) to avoid module instance isolation bugs
- Passwords flow via stdin or git-credential only — never CLI flags or environment variables
- Session tokens are the only data persisted to disk
- `execFile` for all subprocess calls (not `exec`)
