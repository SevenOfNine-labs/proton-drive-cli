# Doctor Reference

`proton-drive-cli doctor` is the offline preflight: it inspects the local
session file, the session's credential-store entry and the entry point
without logging in, refreshing tokens or calling the Proton API (`pass-cli`
can contact Proton Pass to read the entry), and reports whether a transfer or a
live canary may be attempted. Source of truth: `src/cli/doctor.ts`;
JSON output schema: `schemas/doctor/v1/report.schema.json`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--credential-store <store>` | the store recorded in the session | Credential store to verify instead: `pass-cli` or `git-credential` |
| `--credential-host <host>` | the host recorded in the session | Credential host to verify instead |
| `--drive-cli-bin <path>` | `PROTON_DRIVE_CLI_BIN`, else the running entry point | Entry point whose existence is checked |
| `--session-file <path>` | `~/.proton-drive-cli/session.json` | Session file to inspect |
| `--json` | off | Print the report as JSON |
| `--strict` | off | Treat warnings as a failure |

## Checks

| `id` | Title | Result |
| --- | --- | --- |
| `drive-cli-bin` | proton-drive-cli entry point | `pass` when the file exists, else `fail` |
| `session-credentials` | session credentials | `skip` without a login session; `fail` when the session's entry cannot be read from the credential store or the store is unsupported; `pass` when it is readable |
| `session-file` | session file hygiene | `warn` when no session file exists; `fail` when its mode allows group or other access, or it is not a login session (it lacks one of `uid`, `credentialStore`, `credentialHost`, `revision`, or is unreadable); `pass` otherwise |

Statuses are `pass`, `warn`, `fail`, `skip`. Each check carries `message`
and, when something must be done, `remediation`.

## Report

```json
{
  "ok": true,
  "summary": {"pass": 3, "warn": 0, "fail": 0, "skip": 0},
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
| `authState` | The `bridge auth-state` payload for the session file of `--session-file` |
| `canAttemptTransfer` | `ok` and `authState.state` is `ready` or `session_expired` (`bridge init` refreshes an expired access token before use) |
| `canAttemptLiveCanary` | `ok` and `authState.state` is `ready` or `needs_login` (a login canary may start without a session) |
| `checks` | The three checks above, in that order |

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

- The `proton-lfs-cli` tray's "Run Doctor..." runs it without store flags,
  so it checks the store and host recorded in the session.
- The parent repository's `internal/preflight` package and
  `scripts/check_doctor_readiness.go` parse `doctor --json` and require
  `canAttemptTransfer`, `canAttemptLiveCanary` or an exact
  `authState.state` before any guarded live canary (`make
  live-canary-preflight`, `make browser-fork-canary`, `make test-e2e-real`).
  The allowed `authState.state` values are read from
  `schemas/bridge/v1/auth-state-payload.schema.json`.
