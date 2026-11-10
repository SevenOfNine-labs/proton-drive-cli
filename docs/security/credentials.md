# Credential Security

## Trust Boundaries

```
Proton browser sign-in
    ↓
browser session-fork payload
    ↓
proton-drive-cli login
    ├── tokens and key password -> one credential-store entry per session UID
    └── non-secret record       -> ~/.proton-drive-cli/session.json
```

The CLI never receives the Proton account password: it is entered only on
Proton's sign-in page. The session-fork payload carries the user key password
for every account, including accounts with a separate mailbox password.

## Stored Secrets

| Data | Storage | Purpose |
| --- | --- | --- |
| Access token, refresh token, browser-derived key password | One entry in the credential store (`pass-cli` or `git-credential`), username = session UID, host `proton-drive-cli.invalid` | API requests, token refresh, unlocking the user keys and then the address keys (official account module, `addresses.ts`) |
| UID, scopes, credential store and host, revision, token expiry | `~/.proton-drive-cli/session.json` (`0600`) | Locating the entry; local expiry check; tray readiness |
| User and address records with their passphrase-protected keys | `~/.proton-drive-cli/crypto-cache.json` (`0600`, one hour) | Skipping two API reads per bridge process |

RFC 6749 (10.4) requires refresh tokens to be kept confidential in storage;
RFC 6819 (5.1.4.1.4, 4.1.3) recommends an encrypted store for client secrets
and the same protection for access tokens. No file this CLI writes holds a
token or the key password (CWE-312). The state directory is `0700`.

Every save is read back and compared before it counts, and a failed save is
retried three times within 30 seconds. Every entry carries the
`session.json` revision it was written with and, for a refresh, the
revision it replaces; a refresh refuses an entry of another revision unless
it replaces the revision of `session.json`, the trace of a refresh that
stopped before writing `session.json`. Logout, a refresh token the API
rejects, and a login that yields a new session UID remove the entry of the
session they end (OWASP ASVS 5.0 14.3.1).

## Credential Stores

### pass-cli

The entry is a Proton Pass login item whose title contains the credential
host, whose URL is `https://<host>` and whose username is the session UID.
It is stored in a vault the account owns, or, when it owns none (personal
access token, agent session), in one it may edit as Manager or Editor. A
save creates the new item from a template on stdin and then permanently
deletes every earlier item of the session; `pass-cli item update` is not
used because it takes values as command-line arguments (CWE-214). A
deletion that fails is logged and repeated by the next save or logout.
Reads list active items (`--filter-state active`), view them newest first
by `create_time` across all vaults and return the first of the session; a
failed view fails the read, so an older item never stands in for a newer
one. Every read and save contacts Proton Pass.

pass-cli encrypts its local data with a key from its key provider
([pass-cli key storage](https://protonpass.github.io/pass-cli/get-started/configuration/#secure-key-storage)).
On Linux the default is the kernel keyring: a reboot (or a WSL restart)
clears the key, and a login session with its own session keyring
(keyrings(7), such as an SSH login) cannot see it. pass-cli then logs out
and deletes its local data, and the entry becomes unreadable
(`credentials_unavailable`) until `pass-cli login`.
`PROTON_PASS_LINUX_KEYRING=dbus` keeps the key in the Secret Service; set it
before `pass-cli login` for every process that runs pass-cli, which inherits
the environment of this CLI. `PROTON_PASS_KEY_PROVIDER=fs` keeps the key in
a plain file next to the encrypted data, which pass-cli documents as less
secure, for systems without a Secret Service. Personal access token and agent sessions last two hours, and agent
sessions need `PROTON_PASS_AGENT_REASON` for item commands, which this CLI
does not set.

### git-credential

`git credential fill/approve/reject` (git-credential(1)) with the entry as
`protocol=https`, `host=<credential host>`, `username=<UID>` and the JSON
secret as `password`. `git credential approve` sends the credential to every
configured helper (git-credential(1)); the `store` helper writes plaintext
(git-credential-store(1)) and `cache` forgets after a timeout
(git-credential-cache(1)). The CLI therefore runs git with exactly one
helper, the first configured one that encrypts secrets at rest:

| Helper | Store |
| --- | --- |
| `osxkeychain` | macOS login keychain |
| `wincred` | Windows Credential Manager, `CRED_PERSIST_LOCAL_MACHINE` |
| `libsecret` | freedesktop Secret Service, default collection |
| `manager` (Git Credential Manager) | `wincredman` or `dpapi` on Windows, `keychain` or `gpg` on macOS, `secretservice` or `gpg` elsewhere (`GCM_CREDENTIAL_STORE`, else the last `credential.credentialStore` git applies to the host) |

Helpers are read from `credential.helper` and from every
`credential.<url>.helper` whose URL git applies to `https://<credential
host>` (gitcredentials(7), "CREDENTIAL CONTEXTS": scheme, host with `*`
labels, default port, path; for example
`credential.https://proton-drive-cli.invalid.helper`), in the system and
global scopes, in configuration order, include directives followed
(`--show-scope`, `--includes`); a URL with a user name is refused, since it
depends on the session UID. `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_GLOBAL` and
`GIT_CONFIG_NOSYSTEM` apply as for git itself; an empty value resets the
list, as in git. Without such a
helper the save and every read fail with the configured helpers named; the
scope listing needs git 2.26 or newer. A value with quotes, expansions,
shell operators, redirections or globs is never selected, since git passes
it to the shell (gitcredentials(7), "CUSTOM HELPERS"). A save runs
`approve` and reads the entry back with `fill`; when the helper kept the
existing item, it runs `reject` and `approve` (git-credential(1)).

git runs outside any repository (in the file-system root, without
`GIT_DIR` and `GIT_WORK_TREE`), so repository configuration never applies,
with `-c credential.helper= -c
credential.helper=<selected> -c credential.interactive=false`,
`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=false`, `GCM_GUI_PROMPT=false`,
`GCM_PROVIDER=generic` and, for Git Credential Manager, `GCM_CREDENTIAL_STORE`
set to the validated store, which overrides any configuration (GCM
docs/environment.md). A Windows Git Credential Manager started from WSL
(`git-credential-manager.exe`) receives these through `WSLENV`. Neither git
nor Git Credential Manager prompts for credentials; the operating system may
still ask to unlock a locked keychain or keyring, or gpg-agent for a
passphrase.

The secret is at most 1280 characters, so Git's wincred helper, which stores
UTF-16, stays within `CRED_MAX_CREDENTIAL_BLOB_SIZE` (2560 bytes, wincred.h).
The entry carries no `password_expiry_utc`: `git credential fill` drops an
expired password (git-credential(1)), and with it the refresh token.

### Direct OS secret-store access

Proton's official CLI calls the OS secret store through `Bun.secrets`.
Node.js has no such API. The maintained binding, `@napi-rs/keyring` 2.1.2,
writes Windows credentials with `CRED_PERSIST_ENTERPRISE`, which Microsoft
documents as visible to the user's logon sessions on other computers, with
no way for the caller to choose `CRED_PERSIST_LOCAL_MACHINE`; on macOS it
uses the `SecKeychain` API where TN3137 recommends `SecItem`; and
by default it falls back to the kernel keyring,
which does not persist across reboots, when no Secret Service is on the
session bus. The `git-credential` store reaches the same OS stores through
Git's helpers, which use `CRED_PERSIST_LOCAL_MACHINE` and the Secret Service
default collection.

## What Is Never Allowed

| Vector | Status |
| --- | --- |
| A password in CLI flags, stdin or environment variables | No command reads one |
| A secret in a bridge request | No request field carries one; unknown fields are rejected |
| A secret in `session.json`, a log line or an error message | Tokens and key password exist only in the credential-store entry and in process memory |
| Login from the bridge | No bridge command logs in |

## Offline Gates

`proton-drive-cli doctor` and `proton-drive-cli bridge auth-state` inspect
local state and read the session's credential-store entry. They never
refresh tokens or send a request to the Proton API; `pass-cli` can contact
Proton Pass to read the entry.
