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

1. `proton-drive-cli login` starts `GET /auth/v4/sessions/forks`.
2. The user signs in on `account.proton.me`.
3. The CLI polls the fork selector.
4. The encrypted fork payload is decrypted locally.
5. Session tokens are saved to `session.json`.
6. The browser-derived key password is stored in the configured key-password
   provider and verified by readback before the session is accepted.

The SRP module adapter (`src/sdk/srpAdapter.ts`) implements the SDK's
`SRPModule` interface, which the Drive SDK uses for its own password-protected
features; it is not an account-login path.

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

The bridge cannot create a Proton account session. It refreshes the existing
session's tokens and unlocks the account keys with the stored key password.

## Bridge Protocol

The bridge writes a strict `{ ok, payload, error, code, details }` envelope.
Requests are validated against `schemas/bridge/v1/request-field-rules.json`
before credential lookup, network access, or local file operations.

Supported commands: `auth-state`, `init`, `upload`, `download`, `exists`,
`batch-exists`, `delete`, `batch-delete`, and `list`. Each success payload is
described by `schemas/bridge/v1/payloads/<command>.schema.json`; every error
envelope carries `details.errorCode` from `schemas/bridge/v1/error-code-map.json`.

No request field carries a secret; unknown fields are rejected.

## Non-Negotiables

- Account password entry happens only in Proton's browser sign-in page.
- No production path may submit account passwords or SRP auth proofs.
- `auth-state` and `doctor` send no request to the Proton API; the
  key-password check runs the credential provider, and `pass-cli` can contact
  Proton Pass.
- Session files store tokens and metadata only, never passwords.
- The bridge fails closed unless the local auth state is `ready`.
