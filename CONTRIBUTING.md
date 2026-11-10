# Contributing

proton-drive-cli is the Proton Drive backend of
[proton-lfs-cli](https://github.com/SevenOfNine-labs/proton-lfs-cli). Bug
reports, fixes and documentation improvements are welcome.

## Reporting

- Bugs and feature requests: [open an issue](https://github.com/SevenOfNine-labs/proton-drive-cli/issues/new/choose).
  Attach `proton-drive-cli doctor --json`; it holds no secret.
- Vulnerabilities: follow [SECURITY.md](SECURITY.md), never a public issue.
- Never paste a session token, key password, `pass-cli` output or a
  credential-store entry into an issue or pull request.

## Development Setup

Follow [From source](README.md#from-source): Node.js 22 or later, Yarn 4
through Corepack, and the vendored Proton SDK built once. Then install the
Git hooks, which run the comment policy, file checks and the commit message
check on every commit:

```bash
pip install pre-commit   # or pipx, brew
pre-commit install       # installs the pre-commit and commit-msg hooks
```

## Checks

CI runs these on every pull request; run them before you push:

```bash
yarn lint                              # tsc --noEmit
bash scripts/check-comment-policy.sh
yarn build
yarn test --maxWorkers=2
npx markdownlint-cli2@0.24.0 --config .markdownlint.json README.md SUMMARY.md SECURITY.md CONTRIBUTING.md 'docs/**/*.md'
```

Tests are offline: they mock the Proton API, the credential stores and the
home directory (`jest.mock('os')` with a temporary `homedir`), and never read
or write the real `~/.proton-drive-cli`. Real-account checks are a separate,
guarded canary in proton-lfs-cli.

## Code and Documentation

- TypeScript in strict mode; a test next to every behavior change
  (`*.test.ts`).
- Prefer a maintained library to new code for anything a standard or a
  common package covers.
- Comments cite a standard, a specification or external documentation, or
  state an invariant, in at most three lines; docs and comments describe the
  current behavior only. [AGENTS.md](https://github.com/SevenOfNine-labs/proton-drive-cli/blob/main/AGENTS.md) has the full comment policy;
  `scripts/check-comment-policy.sh` enforces its vocabulary.
- Update the docs under `docs/` with every change to commands, flags, the
  bridge contract (`schemas/bridge/v1/`) or the auth flow.

## Commits and Pull Requests

- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
  `<type>(<scope>): <subject>`, header at most 72 characters, subject not
  capitalized and without a final period. Types: `feat`, `fix`, `docs`,
  `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`. A breaking
  change adds `!` after the type or scope and a `BREAKING CHANGE:` footer.
  `commitlint.config.mjs` holds the rules; the pull request title follows
  them as well.
- Sign off every commit (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/), and
  sign it (`-S`) when you can.
- One logical change per pull request, with the test evidence in its
  description. `main` accepts changes only through pull requests whose
  checks pass.

Contributions are licensed under the [MIT License](https://github.com/SevenOfNine-labs/proton-drive-cli/blob/main/LICENSE).
