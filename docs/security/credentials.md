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

The CLI never receives the Proton account password: it is entered only on
Proton's sign-in page. The session-fork payload carries the user key password
for every account, including accounts with a separate mailbox password, so
the key password is the only secret the CLI stores.

## Stored Secrets

| Secret | Storage | Purpose |
| --- | --- | --- |
| Access/refresh tokens | `~/.proton-drive-cli/session.json` | Existing session lifecycle |
| Browser-derived key password | `git-credential` or `pass-cli`, entry keyed by the session UID | Unlock the user keys, then the address keys (official account module, `addresses.ts`) |

The session directory is `0700`; session, crypto-cache and cooldown files
are `0600`. Logout, a refresh token the API rejects, and a login that yields
a new session UID remove the key-password entry of the session they end. A
`pass-cli` entry is stored in a vault the account owns, or, when it owns none
(personal access token, agent session), in one it may edit as Manager or
Editor; a vault shared with others is used only in that second case.

## What Is Never Allowed

| Vector | Status |
| --- | --- |
| A password in CLI flags, stdin or environment variables | No command reads one |
| A secret in a bridge request | No request field carries one; unknown fields are rejected |
| Login from the bridge | No bridge command logs in |

## Offline Gates

`proton-drive-cli doctor` and `proton-drive-cli bridge auth-state` inspect
local state and the session's key-password entry. They never refresh tokens
or send a request to the Proton API; `pass-cli` can contact Proton Pass to
read the entry.
