# Architecture Overview

## Components

```
proton-drive-cli
├── CLI layer        — browser-fork login, file commands, doctor, bridge
├── SDK adapter      — wraps @protontech/drive-sdk for CLI transfer use
├── Auth lifecycle   — existing-session refresh/logout only
├── Browser fork     — official Proton browser session-fork login
├── Crypto service   — OpenPGP key management via @protontech/openpgp
└── Bridge protocol  — JSON stdin/stdout interface for Git LFS integration
```

## Auth Model

The only account authentication path is Proton browser session-fork:

1. `proton-drive login` starts `GET /auth/v4/sessions/forks`.
2. The user signs in on `account.proton.me`.
3. The CLI polls the fork selector.
4. The encrypted fork payload is decrypted locally.
5. Session tokens are saved to `session.json`.
6. The browser-derived key password is stored in the configured key-password
   provider and verified by readback before the session is accepted.

Direct SRP account-password login is not part of production runtime. SRP code
that remains is SDK/key-derivation plumbing and is not an account-login path.

## Git LFS Integration

```
Git LFS custom transfer adapter
    ↓
proton-drive-cli bridge auth-state  (local-only readiness gate)
    ↓
proton-drive-cli bridge init/upload/download
    ↓
createSDKClient(existing browser-fork session)
    ↓
ProtonDriveClient
```

The bridge cannot create a Proton account session. It can refresh existing
tokens, unlock browser-fork key material, and consume data-password inputs for
two-password accounts.

## Bridge Protocol

The bridge writes a strict `{ ok, payload, error, code, details }` envelope.
Requests are validated against `schemas/bridge/v1/request-field-rules.json`
before credential lookup, network access, or local file operations.

Supported commands: `auth-state`, `upload`, `download`, `list`, `exists`,
`delete`, `refresh`, `init`, `batch-exists`, and `batch-delete`.

Legacy login-shaped request fields are rejected.

## Non-Negotiables

- Account password entry happens only in Proton's browser sign-in page.
- No production path may submit account passwords or SRP auth proofs.
- `auth-state` and `doctor` stay offline and local-only.
- Session files store tokens and metadata only, never passwords.
- The bridge fails closed unless the local auth state is `ready`.
