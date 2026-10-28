#!/usr/bin/env bash
# PreToolUse: block hand-edits to the generated bundle. `pnpm build` writes dist/ and
# CI `build-and-check-dist` fails on drift, so a direct edit there is always wrong.
set -u
command -v jq >/dev/null 2>&1 || exit 0
file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

case "$file" in
  "$root"/dist/* | dist/*)
    jq -n '{hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "dist/ is generated. Change src/ instead, then run `pnpm build` and commit dist/ (AGENTS.md golden rule 2)."}}'
    ;;
esac
exit 0
