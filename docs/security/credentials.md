# Credential Security

## Trust Boundaries

```
Proton browser sign-in
    ↓
browser session-fork payload
    ↓
proton-drive-cli login
    ├── session tokens -> ~/.proton-drive-cli/session.json
    └── key password   -> UID-scoped key-password provider entry
```

The CLI never receives the Proton account password. It never resolves account
credentials from `git-credential`, `pass-cli`, stdin, environment variables, or
bridge JSON.

## Stored Secrets

| Secret | Storage | Purpose |
| --- | --- | --- |
| Access/refresh tokens | `~/.proton-drive-cli/session.json` | Existing session lifecycle |
| Browser-derived key password | `git-credential` or `pass-cli` | Unlock user keys for Drive SDK |
| Data/mailbox password | Optional caller-provided source | Two-password accounts only |

The session directory is `0700`; session and cooldown files are `0600`.

## What Is Never Allowed

| Vector | Status |
| --- | --- |
| Account password in CLI flags | Rejected |
| Account password via stdin | Rejected |
| Account password in environment variables | Rejected |
| Bridge account login | Rejected |
| Direct SRP account-password login | Rejected |

## Offline Gates

`proton-drive doctor` and `proton-drive bridge auth-state` inspect only local
state. They do not perform token refresh, remote validation, SRP login, or
account-password credential lookup.
