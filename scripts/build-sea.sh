#!/usr/bin/env bash
# build-sea.sh — Build proton-drive-cli as a Node.js single executable
# application (`node --build-sea`, https://nodejs.org/api/single-executable-applications.html)
# from sea-config.json and the running node binary.
#
# Prerequisites: Node.js matching .node-version; yarn build.
# Output: bin/proton-drive-cli (.exe on Windows), or $SEA_OUTPUT_DIR when set.
set -euo pipefail

DRIVE_CLI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${SEA_OUTPUT_DIR:-${DRIVE_CLI_DIR}/bin}"
NODE="${NODE:-node}"
SEA_CONFIG="sea-config.json"

# A relative SEA_OUTPUT_DIR is taken from the caller's directory (POSIX form
# everywhere, including Git Bash on Windows), not from this repository.
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$(pwd)/${OUTPUT_DIR}" ;;
esac

cd "$DRIVE_CLI_DIR"

if [ ! -f "$SEA_CONFIG" ]; then
  echo "Error: ${DRIVE_CLI_DIR}/${SEA_CONFIG} not found." >&2
  exit 1
fi

# "main" and "output" come from the tracked config so this script and the
# config cannot disagree.
sea_config_value() {
  "$NODE" -e 'const c = require(process.argv[1]); process.stdout.write(String(c[process.argv[2]] ?? ""))' "./${SEA_CONFIG}" "$1"
}
BUNDLE_FILE="$(sea_config_value main)"
SEA_OUTPUT="$(sea_config_value output)"
if [ -z "$BUNDLE_FILE" ] || [ -z "$SEA_OUTPUT" ]; then
  echo "Error: ${SEA_CONFIG} must define \"main\" and \"output\"." >&2
  exit 1
fi

# Intermediate files never outlive the script, whether it succeeds or fails.
cleanup() {
  rm -f "$BUNDLE_FILE" "$SEA_OUTPUT"
}
trap cleanup EXIT

NODE_VERSION="$("$NODE" --version)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
REQUIRED_VERSION="$(tr -d '[:space:]' < .node-version)"
REQUIRED_MAJOR="${REQUIRED_VERSION#v}"
REQUIRED_MAJOR="${REQUIRED_MAJOR%%.*}"
if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  echo "Error: node ${NODE_VERSION} is too old for this build; use Node.js ${REQUIRED_VERSION} (see .node-version)." >&2
  exit 1
fi
echo "    Using node: $(command -v "$NODE") (${NODE_VERSION})"

echo "==> Step 1: esbuild bundle"
if [ ! -f dist/index.js ]; then
  echo "Error: dist/index.js not found. Run 'yarn build' first." >&2
  exit 1
fi
"$NODE" esbuild.config.mjs

echo "==> Step 2: Build SEA binary"
"$NODE" --build-sea "$SEA_CONFIG"

OUTPUT_NAME="$SEA_OUTPUT"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  OUTPUT_NAME="${SEA_OUTPUT}.exe"
fi

# macOS: the injected binary needs a fresh ad-hoc signature to run.
if [[ "$OSTYPE" == "darwin"* ]]; then
  codesign --force --sign - "$SEA_OUTPUT"
fi

mkdir -p "$OUTPUT_DIR"
mv "$SEA_OUTPUT" "$OUTPUT_DIR/$OUTPUT_NAME"
chmod +x "$OUTPUT_DIR/$OUTPUT_NAME"

echo "==> SEA binary ready: $OUTPUT_DIR/$OUTPUT_NAME"
