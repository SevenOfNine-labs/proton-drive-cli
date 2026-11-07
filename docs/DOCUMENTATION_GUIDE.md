# Documentation Guide

Document the browser-fork/session-only contract.

Do:

- Show `proton-drive-cli login` as browser sign-in.
- Show `proton-drive-cli doctor` and `proton-drive-cli bridge auth-state` as
  local readiness checks.
- Describe the credential store as the only place the session tokens and the
  browser-fork key password are kept; `session.json` holds no secret.
- Describe the current behaviour only; history lives in Git and the
  changelog (AGENTS.md, comment rules).

Do not:

- Show a password in a command line, stdin, an environment variable or a
  bridge request; the CLI reads none.
- Describe login from the bridge; the bridge never logs in.

Regenerate generated API docs with:

```bash
yarn docs
```
