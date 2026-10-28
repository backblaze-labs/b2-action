# Review instructions

How a review pass runs on a `b2-action` pull request, for human reviewers and AI review alike. The agent that wrote a change never approves it: approval belongs to a human code owner through branch protection. Findings inform that decision; they do not approve or block on their own.

## What failure looks like here

The Action is a thin dispatcher over `@backblaze-labs/b2-sdk`, so the expensive bugs live at its boundaries, not in algorithms. Go looking for:

- An input that parses but never reaches the SDK (the `keep-days` class of bug).
- The wrong bucket, id, or option handed to the SDK (the cross-bucket `copyLargeFile` class of bug).
- An output that is right on success but missing or wrong on a failure path, or a secret that reaches an output, a log line, or `summary-json`.
- `dist/` not rebuilt, or `action.yml` and the README reference tables out of step.
- A test that still passes with the fix reverted.

## Passes

Run each pass over the full diff and tag every finding with its pass.

- **Bugs**: logic errors, edge cases (empty prefix, trailing slash, `~` paths, Windows paths, zero files), regressions, and inputs parsed but not forwarded.
- **Contract**: every `action.yml` input and output is still documented and emitted; failure paths set `retryable` and `retry-after` only when a retry is safe; `summary-json` caps and redaction still hold; the User-Agent tokens are untouched.
- **Security**: secrets are masked at the boundary and never reach outputs, logs, or summaries; nothing replaces the SDK with raw HTTP or a subprocess; workflow changes keep SHA pins, least-privilege `permissions`, `persist-credentials: false`, and the Dependabot guard.
- **Compliance**: the change does what its issue asks and, for larger work, follows its plan in `docs/exec-plans/active/`; the golden rules in [AGENTS.md](AGENTS.md) hold; user-visible changes carry a CHANGELOG `[Unreleased]` entry; a bug fix ships with a test that pins it.

## Severity

- **Important**: breaks behavior, leaks a secret, violates a golden rule, or would ship a broken release. Fix before merge.
- **Nit**: style, naming, or wording. Report at most five and summarize the rest as a count.
- **Pre-existing**: real, but not introduced by this diff. Report it once, suggest an issue, and do not block on it.

## Evidence

Every finding cites `path:line` from the diff and states the concrete failure: which inputs produce which wrong output. A finding with no line or no reproduction is a question, so ask it as one.

## Report format

Lead with the counts (Important, Nit, Pre-existing), then one table sorted by severity:

| Severity | Pass | File:Line | Issue |
| --- | --- | --- | --- |
| Important | Contract | `src/main.ts:120` | `retry-after` set on a non-retryable failure |

Close by saying that approval is the code owner's call.

## Do not report

- Anything a CI gate already enforces: Biome style, typecheck, coverage thresholds, `dist/` freshness, actionlint and pin checks, spelling, Markdown lint, and link checks. Trust the gate; mention it only if a gate is missing.
- Generated or vendored output: `dist/`, `api-docs/`, `coverage/`, and lockfile churn.
- Preferences that contradict [AGENTS.md](AGENTS.md) or [ARCHITECTURE.md](ARCHITECTURE.md).

## Convergence

- Round one reviews the whole diff. From round three on, review only what changed since the previous round.
- Do not repeat a finding that has been answered; reply on its thread instead.
- After three rounds with only nits left, stop and hand the PR to the code owner.
- When a reviewer has to raise the same mistake on a second PR, record it in AGENTS.md (golden rules) or in this file as part of that PR.
