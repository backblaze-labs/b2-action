# Review instructions

How a review pass runs on a `b2-action` pull request, for human reviewers and AI review alike. The agent that wrote a change never approves it: approval belongs to a human code owner through branch protection, and a bot's approval never fills a slot that needs a person. Findings inform that decision; they do not approve on their own.

## Where review runs

1. **Before the PR.** The author runs `pnpm ci:local`, then a fresh-context review: `/code-review` and `/security-review` in Claude Code, or the `verifier` subagent. Show the command output; do not just say it passed.
2. **On every PR.** Two Claude passes in [claude-review.yml](.github/workflows/claude-review.yml), this file's passes and a separate security pass, plus Copilot review from the `main` ruleset. Each posts inline findings; none approves.
3. **By a human.** A code owner reads the evidence (check output, findings, the plan) and decides. If you cannot say what the checks would miss, review the code yourself instead of approving quickly.

Every finding gets an answer before merge: fix it, or resolve the thread with a one-line reason (wrong, intentional, or not worth it). Reply with the commit that contains a fix, and confirm the fix is in the pushed diff before you say "Fixed".

## What failure looks like here

The Action is a thin dispatcher over `@backblaze-labs/b2-sdk`, so the expensive bugs live at its boundaries, not in algorithms. Go looking for:

- An input that parses but never reaches the SDK (the `keep-days` class of bug).
- The wrong bucket, id, or option handed to the SDK (the cross-bucket `copyLargeFile` class of bug).
- An output that is right on success but missing or wrong on a failure path, or a secret that reaches an output, a log line, or `summary-json`.
- `dist/` not rebuilt, or `action.yml` and the README reference tables out of step.
- A test that still passes with the fix reverted.

The full catalogue, mined from every review on the merged PRs, is [docs/design-docs/review-lessons.md](docs/design-docs/review-lessons.md). Walk the sections for the areas the diff touches; the most frequent misses are stale comments and docs, tests that do not prove the fix, Windows behavior, and scripts that exit 0 without running.

## Passes

Run each pass over the full diff and tag every finding with its pass.

- **Bugs**: logic errors, edge cases (empty prefix, trailing slash, `~` paths, Windows paths, zero files), regressions, and inputs parsed but not forwarded. For a bug fix, check that it fixes the root cause rather than the symptom, and that the change solves the problem its issue states without breaking something else.
- **Contract**: every `action.yml` input and output is still documented and emitted; failure paths set `retryable` and `retry-after` only when a retry is safe; `summary-json` caps and redaction still hold; the User-Agent tokens are untouched.
- **Security**: secrets are masked at the boundary and never reach outputs, logs, or summaries; nothing replaces the SDK with raw HTTP or a subprocess; workflow changes keep SHA pins, least-privilege `permissions`, `persist-credentials: false`, and the Dependabot guard.
- **Compliance**: the change does what its issue asks and, for larger work, follows its plan in `docs/exec-plans/active/`; the golden rules in [AGENTS.md](AGENTS.md) hold; user-visible changes add a changie fragment under `.changes/unreleased/` whose wording a user would understand; a bug fix ships with a test that pins it. Flag edits that make AGENTS.md, a doc under `docs/`, or a comment stale.

## Severity

- **Important**: breaks behavior, leaks a secret, violates a golden rule, or would ship a broken release. Fix before merge.
- **Nit**: style, naming, or wording. Report at most five and summarize the rest as a count.
- **Pre-existing**: real, but not introduced by this diff. Report it once, suggest an issue, and do not block on it.

## Evidence

Every finding cites `path:line` from the diff and states the concrete failure: which inputs produce which wrong output. A finding with no line or no reproduction is a question, so ask it as one; do not guess from a name.

Flag the bug class, not just the line: when the same mistake can occur elsewhere in the diff or the repository, say so and list every instance you found, so the author fixes all of them in one round.

## Report format

Lead with the counts (Important, Nit, Pre-existing), then one table sorted by severity:

| Severity | Pass | File:Line | Issue |
| --- | --- | --- | --- |
| Important | Contract | `src/main.ts:120` | `retry-after` set on a non-retryable failure |

When there is nothing to fix, say so plainly in one line ("0 Important, 0 Nit, 0 Pre-existing: nothing to fix") instead of inventing findings. Close by saying that approval is the code owner's call.

## Do not report

- Anything a CI gate already enforces: Biome style, typecheck, coverage thresholds, `dist/` freshness, actionlint and pin checks, spelling, Markdown lint, and link checks. Trust the gate; mention it only if a gate is missing.
- Generated or vendored output: `dist/`, `api-docs/`, `coverage/`, and lockfile churn.
- Preferences that contradict [AGENTS.md](AGENTS.md) or [ARCHITECTURE.md](ARCHITECTURE.md).

## Convergence

- Round one reviews the whole diff. From round three on, review only what changed since the previous round.
- Do not repeat a finding that has been answered; reply on its thread instead. An automated pass can review an older commit; check which commit it targeted before acting on a repeat.
- After three rounds, stop. If Important findings are still appearing, ask the author to reconsider the approach rather than patching line by line; if only nits remain, hand the PR to the code owner.
- When a reviewer has to raise the same mistake on a second PR, record it in AGENTS.md (golden rules) or in this file as part of that PR.
