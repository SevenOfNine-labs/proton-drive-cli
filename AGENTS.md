# Repository Guidelines

## Project Structure & Module Organization

- `src/cli/`: User-facing commands (`login`, `ls`, `upload`, `bridge`, credential flows).
- `src/auth/`: Authentication/session setup, SRP, CAPTCHA handling, token refresh.
- `src/drive/`: Proton Drive operations and encrypted metadata/file workflows.
- `src/crypto/`: OpenPGP and encryption/decryption helpers.
- `src/sdk/`: Wrapper layer around `@protontech/drive-sdk`.
- `src/credential/`: Credential-provider implementations and validation.
- `docs/`: Architecture, security, and operations docs for this CLI.
- `dist/`: Built output from TypeScript compilation (generated).

## Build, Test, and Development Commands

- `corepack enable && yarn install`: Install dependencies with Yarn 4.
- `yarn build`: Compile TypeScript into `dist/`.
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
