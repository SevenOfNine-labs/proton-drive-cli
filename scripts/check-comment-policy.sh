#!/usr/bin/env bash
# Comment policy of AGENTS.md ("Code Comments and Legacy"): exit 1 on forbidden
# words in Markdown, JSON Schema annotations and comment lines of the tracked
# and untracked source files of this repository, submodules excluded.
set -euo pipefail

POLICY_FILE=AGENTS.md
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Case-insensitive, whole words. Identifiers such as openpgp.js'
# "ed25519Legacy" do not match because no word boundary precedes "Legacy".
FORBIDDEN='\b(legacy|deprecated|workaround|work-around|hack|hacky|kludge|for now|for the time being|todo|fixme|xxx|backwards? compat(ible|ibility)?|compatibility shim|previously|formerly|used to|no longer|quick fix|temporary fix|band-aid|kept for compatibility|since version|unfortunately|hopefully)\b'

# Comment markers //, /*, * and # (shell, YAML, TOML, Make, including the
# silent recipe form @#).
COMMENT_LINE='^[[:space:]]*@?(//|/\*|\*|#)|[[:space:]](//|#)[[:space:]]'

# JSON Schema 2020-12 annotation keywords (Validation, section 9).
SCHEMA_ANNOTATION='"(title|description|\$comment)"[[:space:]]*:'

FILES="$(mktemp)"
trap 'rm -f "$FILES"' EXIT
git ls-files -z --cached --others --exclude-standard -- \
  '*.go' '*.ts' '*.js' '*.mjs' '*.cjs' '*.sh' '*.yml' '*.yaml' '*.toml' '*.md' '*.json' \
  'Makefile' '.env.example' \
  ':!submodules/**' ':!docs/api/**' ':!**/testdata/**' ':!**/node_modules/**' >"$FILES"

status=0

while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    CHANGELOG.md | CLAUDE.md | AGENTS.md | .github/copilot-instructions.md | scripts/check-comment-policy.sh) continue ;;
  esac
  case "$file" in
    *.md) matches="$(grep -nEi "$FORBIDDEN" "$file" || true)" ;;
    *.json) matches="$(grep -nE "$SCHEMA_ANNOTATION" "$file" | grep -Ei "$FORBIDDEN" || true)" ;;
    *) matches="$(grep -nE "$COMMENT_LINE" "$file" | grep -Ei "$FORBIDDEN" || true)" ;;
  esac
  if [ -n "$matches" ]; then
    while IFS= read -r line; do
      printf '%s:%s\n' "$file" "$line"
    done <<<"$matches"
    status=1
  fi
done <"$FILES"

if [ "$status" -ne 0 ]; then
  echo >&2
  echo "Comment policy violations (see $POLICY_FILE, \"Code Comments and Legacy\")." >&2
fi
exit "$status"
