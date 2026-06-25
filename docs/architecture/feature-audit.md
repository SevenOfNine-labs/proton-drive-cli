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

Supported commands: `auth-state`, `upload`, `download`, `list`, `exists`,
`delete`, `refresh`, `init`, `batch-exists`, and `batch-delete`.

The bridge is session-only and rejects legacy login-shaped request fields.

## Test Evidence

- `src/auth/browser-fork.test.ts`
- `src/auth/flow-safety.test.ts`
- `src/cli/bridge.test.ts`
- `src/cli/doctor.test.ts`
- `src/cli/e2e.test.ts`
- `src/sdk/client.test.ts`
