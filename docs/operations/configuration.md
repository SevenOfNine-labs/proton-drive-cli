# Configuration

## Session Storage

| Path                               | Permissions | Contents                                |
| ---------------------------------- | ----------- | --------------------------------------- |
| `~/.proton-drive-cli/`             | `0700`      | Session directory                       |
| `~/.proton-drive-cli/session.json` | `0600`      | Access token, refresh token, session ID |

Session tokens are the only data persisted to disk. Passwords are never stored.

## Environment Variables

The CLI itself does not read credentials from environment variables. The following are used by the parent `proton-lfs-cli` Go adapter:

| Variable                       | Default    | Description                                        |
| ------------------------------ | ---------- | -------------------------------------------------- |
| `PROTON_CREDENTIAL_PROVIDER`   | `pass-cli` | Credential source: `pass-cli` or `git-credential`  |
| `PROTON_PASS_CLI_BIN`          | `pass-cli` | Path to pass-cli binary                            |
| `PROTON_PASS_REF_ROOT`         | —          | pass:// reference root                             |
| `PROTON_PASS_USERNAME_REF`     | —          | pass:// reference for username                     |
| `PROTON_PASS_PASSWORD_REF`     | —          | pass:// reference for password                     |

## CLI Global Options

| Flag                             | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `-d, --debug`                    | Enable debug output with full stack traces                   |
| `--verbose`                      | Show detailed output (spinners, progress, tables)            |
| `-q, --quiet`                    | Suppress all non-error output                                |
| `-v, --version`                  | Display version number                                       |
| `--credential-provider <type>`   | Credential source: `git` (git-credential) or default (stdin) |

## Build and Development

Requires Node.js >= 18 and Yarn 4 (via Corepack).

```bash
corepack enable
yarn install
yarn build          # TypeScript compilation
yarn test           # Run all tests (fully mocked)
yarn test:coverage  # With coverage report
```

The vendored `@protontech/drive-sdk` at `submodules/sdk/js/sdk` must be built before the main project:

```bash
cd submodules/sdk/js/sdk && npm install && npm run build
```

## CAPTCHA Handling

New Proton accounts or untrusted IPs may trigger CAPTCHA during login. The CLI provides:

1. Semi-automated browser-based token extraction
2. Manual token input fallback
3. IP allowlisting wait option

This may require manual intervention and cannot be fully automated.
