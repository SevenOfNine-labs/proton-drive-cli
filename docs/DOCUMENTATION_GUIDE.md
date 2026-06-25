# Documentation Guide

Document the browser-fork/session-only contract.

Do:

- Show `proton-drive login` as browser sign-in.
- Show `proton-drive doctor` and `proton-drive bridge auth-state` as offline
  readiness checks.
- Describe key-password and data-password providers as storage/unlock plumbing.
- Keep bridge examples free of account-login fields.

Do not:

- Document direct account-password login.
- Document removed credential commands.
- Document account password stdin or environment-variable flows.
- Document bridge account login.

Regenerate generated API docs with:

```bash
yarn docs
```
