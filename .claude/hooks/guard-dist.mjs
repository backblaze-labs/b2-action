// PreToolUse: block hand-edits to the generated bundle. `pnpm build` writes dist/ and CI
// `build-and-check-dist` fails on drift, so a direct edit there is always wrong. The path is
// normalized first (`./dist`, `src/../dist`, `/./dist`, symlinks, `link/..` through dist/) so no spelling slips
// past, and an unreadable tool call fails closed with exit 2.

import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path'

function projectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    return process.cwd()
  }
}

// Walk the path one segment at a time, resolving symlinks before applying `..`, the way the OS
// does: `link/../x` where `link` points into dist/ lands in dist/, though it reads as `x`.
function canonical(path) {
  const { root } = parse(path)
  let current = root
  for (const part of path.slice(root.length).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    current = part === '..' ? dirname(current) : join(current, part)
    try {
      current = realpathSync(current)
    } catch {
      // Not there yet (a new file); keep the spelled path.
    }
  }
  return current
}

function refuse(message) {
  process.stderr.write(`guard-dist: ${message}\n`)
  process.exit(2)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
})
process.stdin.on('end', () => {
  let file
  try {
    file = JSON.parse(input).tool_input?.file_path ?? ''
  } catch {
    refuse('could not read the tool call; refusing the edit.')
  }
  if (typeof file !== 'string') refuse('tool_input.file_path is not a string; refusing the edit.')
  if (file === '') return

  const root = projectRoot()
  const rel = relative(canonical(root), canonical(isAbsolute(file) ? file : `${root}${sep}${file}`))
  if (rel === 'dist' || rel.startsWith(`dist${sep}`)) {
    const reason =
      'dist/ is generated. Change src/ instead, then run `pnpm build` and commit dist/ (AGENTS.md golden rule 2).'
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })}\n`,
    )
  }
})
