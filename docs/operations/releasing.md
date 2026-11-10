# Releasing

| Tag | Workflow | Publishes |
| --- | --- | --- |
| `v*` (e.g. `v0.2.0`) | `.github/workflows/release.yml` | GitHub Release with the single executables, `SHA256SUMS.txt` and a git-cliff changelog |

The package is `private` and is not published to npm. proton-lfs-cli pins
this repository as a submodule and bundles the same single executable,
built by the same `scripts/build-sea.sh`.

## What a release contains

`release.yml` runs on every `v*` tag:

1. **build**: on macos-15, ubuntu and windows runners, with the Node.js
   version in `.node-version`, checks that the tag equals `v` plus the
   `package.json` version, builds the vendored SDK and `dist/`, then the
   single executable (`scripts/build-sea.sh`: esbuild bundle,
   `node --build-sea sea-config.json`, ad-hoc `codesign` on macOS). The
   executable must print the `package.json` version for `--version`. Assets:
   `proton-drive-cli-darwin-arm64`, `proton-drive-cli-linux-amd64` and
   `proton-drive-cli-windows-amd64.exe`.
2. **release**: writes `SHA256SUMS.txt` over the executables, generates the
   notes with git-cliff 2.14.2 (`cliff.toml`, verified download) and creates
   the GitHub Release.

The notes open with the message of the annotated tag (git-cliff `message`,
signature removed), followed by a **Breaking changes** list with the
`BREAKING CHANGE:` footer of every commit marked breaking (Conventional
Commits 1.0.0, `!` or footer), then the commits grouped by type.

`workflow_dispatch` runs the build job only: the executables are uploaded as
workflow artifacts and no release is created.

## Steps

```bash
# 1. Set the version in package.json, commit, and check CI on that commit.

# 2. Preview the release notes with the tag message in notes.md
#    (git-cliff 2.14.2, the version release.yml installs)
git-cliff --config cliff.toml --unreleased --tag v0.2.0 --strip header \
  --with-tag-message "$(cat notes.md)"

# 3. Tag the release (annotated, signed) and push the tag
git tag -s --cleanup=whitespace -F notes.md v0.2.0
git push origin v0.2.0
```

The tag message is Markdown: upgrade steps and anything a user must do
before installing. `--cleanup=whitespace` keeps lines starting with `#`,
which the default `strip` mode of git-tag(1) removes as comments.

proton-lfs-cli releases with the same version number tag the commit its
submodule pins, so tag this repository first.

## Verifying

```bash
gh release view v0.2.0
gh release download v0.2.0 --pattern 'proton-drive-cli-linux-amd64' --pattern SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt
```
