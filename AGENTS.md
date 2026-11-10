# Repository Guidelines

## Project Structure & Module Organization

- `src/cli/`: User-facing commands (`login`, `logout`, `status`, `session refresh`, `doctor`, `ls`, `upload`, `download`, `mkdir`, `rm`, `mv`, `cat`, `info`, `bridge`).
- `src/auth/`: Browser-fork login, session persistence and token refresh, session secrets in the credential store.
- `src/bridge/`: Bridge protocol constants, request validators, OID path mapping.
- `src/api/`: HTTP client for the Proton API.
- `src/crypto/`: OpenPGP and encryption/decryption helpers.
- `src/sdk/`: Wrapper layer around `@protontech/drive-sdk`.
- `src/credentials/`: Credential stores (`pass-cli`, `git-credential`) that hold each session's tokens and key password.
- `schemas/`: JSON Schemas of the bridge and doctor contracts.
- `docs/`: Architecture, security, operations, and reference docs for this CLI.
- `dist/`: Built output from TypeScript compilation (generated).

## Build, Test, and Development Commands

- `corepack enable && yarn install`: Install dependencies with Yarn 4.
- `yarn build`: Compile TypeScript into `dist/`.
- `bash scripts/build-sea.sh`: Build the Node.js single executable into `bin/` (Node.js per `.node-version`; `.github/workflows/release.yml` publishes it on `v*` tags, see `docs/operations/releasing.md`).
- `yarn dev`: Run CLI from source for local iteration.
- `yarn test`: Run Jest tests (mocked and CI-safe).
- `yarn test:coverage`: Run Jest with coverage output.
- `yarn lint`: Type-check with `tsc --noEmit`.
- `yarn docs`: Generate TypeDoc API documentation.

## Coding Style & Naming Conventions

- TypeScript: keep strict typing, explicit errors, and narrow interfaces.
- Favor small command/service units over large monolithic handlers.
- Tests use `*.test.ts` naming and should sit near the behavior under test.
- Keep command flags and output contracts stable unless a migration is documented.

## Testing Guidelines

- Add or update unit tests for every behavior change in `src/`.
- Extend CLI/e2e coverage when command flows, flags, or output contracts change.
- Keep tests deterministic and mocked; avoid real Proton credential dependencies.
- Include negative-path checks (auth failures, missing paths, API envelope errors).

## Code Comments and Legacy (MANDATORY)

Comments carry only what the code cannot say: the normative source behind a
decision. Every comment is one of:

- a reference to a standard or specification, with the section where useful
  (RFC 9580 OpenPGP, RFC 9110 HTTP, RFC 2119 keywords, POSIX `rename(2)`,
  Git LFS custom transfer specification, Desktop Entry Specification 1.5,
  XDG Base Directory, JSON Schema 2020-12, NIST SP 800-38D AES-GCM, ...);
- a reference to a scientific publication or a named algorithm (SRP-6a,
  Argon2, ...);
- a reference to external documentation of an API or tool the code relies
  on, naming the file, function or URL (Proton Drive SDK and account module
  sources, Node.js, Go standard library, man pages);
- a one- or two-line statement of an invariant or contract that a reader
  cannot infer from the code (for example "rename(2) replaces the target
  atomically"), or the API contract in a doc comment of an exported symbol.

Forbidden in comments, documentation and commit-facing text alike:

- history and legacy notes: what the code did before, earlier versions,
  former names, "previously", "no longer", "used to", "kept for
  compatibility", "since version X", migration stories;
- excuses, hedges and placeholders: "for now", "workaround", "hack",
  "temporary fix", "TODO", "FIXME", "XXX", "unfortunately", "hopefully";
- narration of what the next lines do, change logs, author notes, and
  references to issues or pull requests in place of the specification;
- comments longer than three lines outside doc comments of exported APIs.

No legacy code: code, options, configuration keys, file formats, schema
fields and documentation that exist only to serve an earlier version are
deleted, not kept behind a comment or a migration. History lives in Git and
in the generated changelog.

`scripts/check-comment-policy.sh` enforces the forbidden vocabulary on every
commit (pre-commit) and in CI; reviews treat any other violation of this
section as a defect.

## Changeset Tracking (MANDATORY)

Every code change **must** be accompanied by updates to two files in the `.changeset/` directory (git-ignored, never committed):

1. **`.changeset/PR_SUMMARY.md`** — A detailed, always-current summary of all changes in the working branch. Update this after every modification. Include:
   - What changed and why
   - Files added/modified/deleted
   - Testing evidence or instructions
   - Any breaking changes or migration notes

2. **`.changeset/COMMIT_MESSAGE.md`** — A ready-to-use commit message following [Conventional Commits](https://www.conventionalcommits.org/). Update this after every modification. Format:
   ```
   <type>(<scope>): <subject>          ← max 72 chars total

   - bullet point details of changes   ← wrap at 72 chars
   - one bullet per logical change
   ```
   Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`.

**Workflow**: Create `.changeset/` dir on first change if it doesn't exist. Update both files after every file edit, creation, or deletion — before moving to the next task.

## Commit & Pull Request Guidelines

- Use Conventional Commits (example: `feat(cli): add bridge retry backoff`).
- Keep changes scoped; avoid mixing behavior changes with unrelated cleanup.
- Include test evidence (`yarn test`, `yarn lint`, targeted Jest command) in PR notes.
- Update docs when command behavior, auth flow, or configuration changes.
- Never commit secrets, sessions, or credential fixtures.
