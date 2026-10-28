---
name: sdlc-feedback-loop
description: Give Claude a way to verify its own work (tests, build, lint, screenshot diff) and protect that check from being weakened. Use when starting implementation or a bug fix, when asked to "set up verification", "fix this bug test-first", or when Claude reports work done without proof; also for UI changes that need a visual check.
---

# Give Claude a feedback loop

> **In `b2-action`:** the verification command is `pnpm ci:local` (see AGENTS.md). Git history is the human's to move ([conventions](../../../docs/design-docs/conventions.md)): where this skill says commit or push, prepare the change and its verification evidence, then stop. Commit or push only when the user asks for that in the current turn; accepting a plan or asking for a review fix is not that request.

Always give the session a way to check its own work before a person sees it. A late signal (CI minutes later, a tester days later) turns the engineer into the bottleneck.

## Set up

1. Wrap verification in one command per concern that exits non-zero on failure (`make test`, `npm test`, `make lint`, `make build`). Create the targets if only a command sequence exists today.
2. List them in `CLAUDE.md` (see `sdlc-claude-md`) with a sample of healthy output, plus the instruction: run the tests before reporting a task complete and show the output.
3. State a quantifiable target for the task so Claude can check without asking: "all tests in X pass", "screenshot matches the attached mock", "the endpoint returns 200 with the new field". Take targets from `plan.md` Proof when it exists.
4. For UI work, give Claude a browser or screenshot tool (e.g. via MCP) and the mock: implement, screenshot, compare, adjust. Two or three rounds is normal.

## Bug fixes: failing test first

1. Reproduce the bug as a test. Run it and confirm it fails for the reason expected, and keep that failing output as evidence.
2. Fix the code without changing the new test's assertions. A test that failed before the fix and passes after it, unchanged, is the proof the bug is gone.
3. Commit the test and the fix together (when committing is authorized). Do not commit the failing test on its own: a pre-commit hook that runs the suite rejects it by design, and the failing output from step 1 already records that the test caught the bug.

## Protect the loop

An agent fixing code must not be able to weaken the check on that code. New tests are expected; a bug fix should add one. What must not happen to existing tests: deleted or loosened assertions, `.skip` or `.only`, lowered coverage thresholds, or expectations rewritten to match the new behavior without the issue or spec calling for it. Either:

- block edits to existing test files during a fix task with a `PreToolUse` hook, while still allowing new test files (`sdlc-hook-gate` and `sdlc-policy-skill` show the pattern), or
- check the diff in review for exactly those weakening changes and reject them (`sdlc-pr-review`), rather than rejecting every change that touches a test.

## Report format

When finishing, paste the literal output of the build, test and lint commands (or the screenshot diff). Evidence comes from the toolchain, not from the agent's summary.

## Governance

Verification before "done" and the block on editing tests are enforced as hooks where the organization wants them guaranteed. Evidence lives in the session transcript and in the PR's check run; the code owner reviews intent and risk because mechanical evidence is already attached.

## Measure

- Leading: first-pass CI success rate of agent-written changes.
- Lagging: review time per PR (should fall) and change failure rate from the incident tracker.
