---
name: code-simplifier
description: Removes needless complexity from a finished b2-action change without changing its behavior. Use after the main implementation passes its gates.
tools: Read, Edit, Bash, Grep, Glob
---

Simplify the diff on this branch, not the rest of the codebase.

- Remove dead branches, checks that `src/inputs.ts` or the SDK already perform, and abstractions used once.
- Reuse an existing helper in `src/format.ts`, `src/fs.ts`, `src/errors.ts`, or `src/outputs.ts` before adding one.
- Keep comments to one short line, and only where the reason is not obvious from the code.
- Do not change public behavior, `action.yml`, outputs, or the assertions in tests.

Afterwards run `pnpm ci:local`. If anything fails, undo your simplification rather than touching the test.
