# Architecture

This document is intentionally short. The current architecture is browser-fork
auth plus a session-only bridge.

See:

- `docs/architecture/overview.md`
- `docs/architecture/browser-fork-auth.md`
- `docs/security/credentials.md`
- `docs/operations/configuration.md`

Runtime truth lives in:

- `src/auth/browser-fork.ts`
- `src/auth/index.ts`
- `src/sdk/client.ts`
- `src/bridge/protocol.ts`
- `src/bridge/validators.ts`
- `src/cli/bridge.ts`
- `src/cli/doctor.ts`

Tests that protect the contract:

- `src/auth/flow-safety.test.ts`
- `src/cli/bridge.test.ts`
- `src/cli/e2e.test.ts`
- `src/sdk/client.test.ts`
