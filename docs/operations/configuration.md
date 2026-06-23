# Configuration

## Session Storage

| Path | Permissions | Contents |
| --- | --- | --- |
| `~/.proton-drive-cli/` | `0700` | Session directory |
| `~/.proton-drive-cli/session.json` | `0600` | Tokens and browser-fork metadata |
| `~/.proton-drive-cli/rate-limit-cooldown.json` | `0600` | Local wait-until timestamp |

No account passwords are written to disk.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PROTON_KEY_PASSWORD_PROVIDER` | `git-credential` | Browser-fork key-password provider |
| `PROTON_KEY_PASSWORD_HOST` | `proton-drive-key.proton-lfs-cli.local` | Key-password credential host/key |
| `PROTON_DATA_CREDENTIAL_PROVIDER` | unset | Optional two-password data source |
| `PROTON_DATA_CREDENTIAL_HOST` | `proton-data.proton-lfs-cli.local` | Data-password credential host/key |
| `PROTON_CREDENTIAL_PROVIDER` | unset | Legacy fallback for key-password provider only |
| `PROTON_DRIVE_CLI_APP_VERSION` | built-in | Proton app-version header override |

`PROTON_DATA_PASSWORD` and `PROTON_SECOND_FACTOR_CODE` are treated as unsafe
legacy secret environment variables by `doctor`.

## Build and Development

```bash
corepack enable
yarn install
yarn build
yarn test --runInBand
```

## Offline Preflight

```bash
proton-drive doctor
proton-drive doctor --json
proton-drive bridge auth-state
```

These commands do not contact Proton.
