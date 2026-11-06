# Feature Audit

## Auth Maturity

| Feature | Status | Notes |
| --- | --- | --- |
| Browser-fork login | Canonical | Only account authentication path. |
| Session refresh/logout | Supported | Existing-token lifecycle only. |
| Doctor/preflight | Supported | Offline/local-only readiness report. |
| Bridge auth-state | Supported | Offline/local-only transfer gate. |
| Direct account-password login | Removed | No production SRP account login. |
| Credential command | Removed | Key/data password providers are storage plumbing only. |

## Bridge Commands

Supported commands: `auth-state`, `init`, `upload`, `download`, `exists`,
`batch-exists`, `delete`, `batch-delete`, and `list`; payload schemas live in
`schemas/bridge/v1/payloads/`.

The bridge is session-only: account-login request fields are rejected.

## Test Evidence

- `src/auth/browser-fork.test.ts`
- `src/auth/flow-safety.test.ts`
- `src/cli/bridge.test.ts`
- `src/cli/doctor.test.ts`
- `src/cli/e2e.test.ts`
- `src/sdk/client.test.ts`
