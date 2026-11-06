# Documentation Guide

Document the browser-fork/session-only contract.

Do:

- Show `proton-drive-cli login` as browser sign-in.
- Show `proton-drive-cli doctor` and `proton-drive-cli bridge auth-state` as offline
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
