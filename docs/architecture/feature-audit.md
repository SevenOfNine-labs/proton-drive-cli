# Feature Audit

## Auth Maturity

| Feature | Status | Notes |
| --- | --- | --- |
| Browser-fork login | Supported | Only way to create a session. |
| Session refresh/logout | Supported | Refresh request as the official account module `ApiClient`; sign-out and logout with the deviations in browser-fork-auth.md. |
| Key unlock | Supported | Stored key password only, as the official `Addresses`. |
| Doctor/preflight | Supported | Local readiness report; no Proton API request. |
| Bridge auth-state | Supported | Local transfer gate; no Proton API request. |

## Bridge Commands

Supported commands: `auth-state`, `init`, `upload`, `download`, `exists`,
`batch-exists`, `delete`, `batch-delete`, and `list`; payload schemas live in
`schemas/bridge/v1/payloads/`.

The bridge is session-only: no request field carries a secret, and unknown
fields are rejected.

## Test Evidence

- `src/auth/browser-fork.test.ts`
- `src/auth/flow-safety.test.ts`
- `src/cli/bridge.test.ts`
- `src/cli/doctor.test.ts`
- `src/cli/e2e.test.ts`
- `src/sdk/client.test.ts`
