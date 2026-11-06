# Doctor Reference

`proton-drive-cli doctor` is the offline preflight: it inspects the local
session file, the credential providers and the entry point without logging
in, refreshing tokens or contacting Proton, and reports whether a transfer
or a live canary may be attempted. Source of truth: `src/cli/doctor.ts`;
JSON output schema: `schemas/doctor/v1/report.schema.json`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--key-password-provider <type>` | `PROTON_KEY_PASSWORD_PROVIDER`, else `pass-cli` | Provider of the browser-fork key password: `pass-cli` or `git-credential` |
| `--key-password-host <host>` | `PROTON_KEY_PASSWORD_HOST`, else `proton-drive-key.proton-lfs-cli.local` | Host/key of that entry |
| `--data-credential-provider <type>` | `PROTON_DATA_CREDENTIAL_PROVIDER` | Provider of the mailbox/data password (two-password accounts) |
| `--data-credential-host <host>` | `PROTON_DATA_CREDENTIAL_HOST`, else `proton-data.proton-lfs-cli.local` | Host/key of that entry |
| `--require-data-password` | off | Fail the data-credential check when no data provider is configured |
| `--drive-cli-bin <path>` | `PROTON_DRIVE_CLI_BIN`, else the running entry point | Entry point whose existence is checked |
| `--session-file <path>` | `~/.proton-drive-cli/session.json` | Session file to inspect |
| `-u, --username <account>` | none | Username hint for the data-credential lookup |
| `--json` | off | Print the report as JSON |
| `--strict` | off | Treat warnings as a failure |

For the key-password check, a provider and host recorded in the session file
take precedence over the environment defaults when the option is not given.

## Checks

| `id` | Title | Result |
| --- | --- | --- |
| `drive-cli-bin` | proton-drive-cli entry point | `pass` when the file exists, else `fail` |
| `secret-env` | secret environment variables | `fail` when `PROTON_DATA_PASSWORD` or `PROTON_SECOND_FACTOR_CODE` is set (secrets must not travel through the environment), else `pass` |
| `key-password-credential` | browser-fork key password | `skip` without a valid session; `fail` when the session is not browser-fork, records no persisted key password, or the entry cannot be read from the provider; `pass` when the UID-scoped entry is readable |
| `data-credential` | mailbox/data credential | `skip` when no data provider is configured (and not required); `fail` with `--require-data-password` and no provider, or when the entry cannot be resolved; `pass` when it resolves |
| `session-file` | session file hygiene | `warn` when no session file exists; `fail` when its mode allows group or other access, it lacks the token fields, it contains `mailboxPassword` or `password`, it was not created by browser-fork, or it lacks `keyPasswordPersisted`; `pass` otherwise |

Statuses are `pass`, `warn`, `fail`, `skip`. Each check carries `message`
and, when something must be done, `remediation`.

## Report

```json
{
  "ok": true,
  "summary": {"pass": 4, "warn": 0, "fail": 0, "skip": 1},
  "authState": {"state": "ready", "...": "see auth-state-payload.schema.json"},
  "canAttemptTransfer": true,
  "canAttemptLiveCanary": true,
  "checks": [{"id": "drive-cli-bin", "title": "proton-drive-cli entry point", "status": "pass", "message": "..."}]
}
```

| Field | Rule |
| --- | --- |
| `ok` | No check failed; with `--strict`, no check warned either |
| `summary` | Count per status |
| `authState` | The offline `bridge auth-state` payload computed with the data-credential options |
| `canAttemptTransfer` | `ok` and `authState.state == "ready"` |
| `canAttemptLiveCanary` | `ok` and `authState.state` is `ready` or `needs_login` (a login canary may start without a session) |
| `checks` | The five checks above, in that order |

The text output prints one `[PASS]`, `[WARN]`, `[FAIL]` or `[SKIP]` line per
check with its remediation, then `Auth state`, `Transfer: ready|blocked`,
`Live canary: ready|blocked` and the summary counts.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | `ok` is true |
| 1 | `ok` is false (a check failed, or warned under `--strict`) |

The report is printed in both cases.

## Consumers

- The `proton-lfs-cli` tray's "Run Doctor..." runs it with the configured
  providers.
- The parent repository's `internal/preflight` package and
  `scripts/check_doctor_readiness.go` parse `doctor --json` and require
  `canAttemptTransfer`, `canAttemptLiveCanary`, an exact `authState.state`
  or `authState.authMode` before any guarded live canary (`make
  live-canary-preflight`, `make browser-fork-canary`, `make test-e2e-real`).
  The allowed `authState.state` values are read from
  `schemas/bridge/v1/auth-state-payload.schema.json`.
