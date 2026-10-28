#!/usr/bin/env bash
# PreToolUse: block hand-edits to the generated bundle. `pnpm build` writes dist/ and
# CI `build-and-check-dist` fails on drift, so a direct edit there is always wrong.
# Parses with node (this repo requires it) and fails closed if the tool call is unreadable.
set -u
file=$(node -e 'let d="";process.stdin.on("data",(c)=>{d+=c}).on("end",()=>{try{process.stdout.write(JSON.parse(d).tool_input?.file_path??"")}catch{process.exit(3)}})') || {
  echo "guard-dist: could not read the tool call; refusing the edit. Check that node is on PATH." >&2
  exit 2
}
[ -n "$file" ] || exit 0
root=${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}

case "$file" in
  "$root"/dist/* | dist/*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"dist/ is generated. Change src/ instead, then run `pnpm build` and commit dist/ (AGENTS.md golden rule 2)."}}'
    ;;
esac
exit 0
