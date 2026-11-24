#!/usr/bin/env bash
# PostToolUse: reject an edit that leaves a source file failing Biome.
# Exit 2 hands the message back to the agent; CI `lint` stays the real gate, so an
# unreadable tool call is skipped rather than blocked.
set -u
file=$(node -e 'let d="";process.stdin.on("data",(c)=>{d+=c}).on("end",()=>{try{process.stdout.write(JSON.parse(d).tool_input?.file_path??"")}catch{}})') || exit 0
[ -n "$file" ] && [ -f "$file" ] || exit 0

case "$file" in
  *.ts | *.mts | *.js | *.mjs | *.json | *.jsonc) ;;
  *) exit 0 ;;
esac
case "$file" in
  */dist/* | */node_modules/* | */coverage/*) exit 0 ;;
esac

root=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null) || exit 0
if ! out=$(cd "$root" && pnpm --silent exec biome check --error-on-warnings --no-errors-on-unmatched "$file" 2>&1); then
  printf 'Biome rejected %s. Run `pnpm lint:fix` or fix it by hand:\n%s\n' "$file" "$out" >&2
  exit 2
fi
exit 0
