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
| `PROTON_DRIVE_CLI_APP_VERSION` | `external-drive-protonlfscli@<package version>` | Proton `x-pm-appversion` override; must match `external-drive-{name}@{major.minor.patch}[-{channel}][+{build}]` where `{channel}` is stable, beta or alpha (`cli-drive` is rejected) |

`PROTON_DATA_PASSWORD` and `PROTON_SECOND_FACTOR_CODE` are treated as unsafe
legacy secret environment variables by `doctor`.

## Build and Development

The vendored Proton SDK (`submodules/sdk/client/js`) must be built once before
the CLI; upstream no longer ships an npm lockfile, so use `npm install`:

```bash
corepack enable
yarn install
(cd submodules/sdk/client/js && npm install --no-package-lock && npm run build)
yarn build
yarn test --runInBand
```

Node.js 22 or newer is required: the SDK relies on `Array.fromAsync`,
`Promise.withResolvers` and the `Uint8Array` base64/hex helpers (the latter are
polyfilled by `src/auth/srp/uint8array-extensions.ts` on Node 22/24).

## Offline Preflight

```bash
proton-drive doctor
proton-drive doctor --json
proton-drive bridge auth-state
```

These commands do not contact Proton.
