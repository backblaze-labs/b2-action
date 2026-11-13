---
name: sdlc-pr-review
description: Set up REVIEW.md and run structured AI review passes (bugs, security, compliance against spec.md/plan.md) on a diff or PR with severity-ranked findings, or address review comments on a PR. Use when asked to "review this PR/diff", "set up PR review", "write REVIEW.md", "address the review comments", or before a PR is marked ready.
---

# AI in the PR review loop

> **In `b2-action`:** `REVIEW.md` already exists, and reviews also walk `docs/design-docs/review-lessons.md`. The spec and plan live in `docs/design-docs/` and `docs/exec-plans/active/`, not `intent/<slug>/`. Evals are deferred here (#257) and are not a prerequisite for review. Git history is the human's to move ([conventions](../../../docs/design-docs/conventions.md)): where this skill says commit or push, prepare the change and its verification evidence, then stop. Commit or push only when the user asks for that in the current turn; accepting a plan or asking for a review fix is not that request.

Claude both gives and receives reviews. Every PR gets the same review passes with findings ranked by severity, so human attention moves up to whether the change does what the plan intended and whether the risk is acceptable. Separation of duties holds: the agent that wrote the code has no way to approve it. Approval comes from a human code owner through branch protection.

## Mode A: set up `REVIEW.md` (tech lead)

1. Ask which passes the organization cares about. Default: Bugs, Security, Compliance (change matches `spec.md`, `plan.md` and design principles).
2. Define what Important means (breaks behavior, leaks data, breaches policy) and treat style and naming as nits.
3. Cap nits (e.g. five per review, summarize the rest as a count) and list what not to report (generated paths, anything CI already enforces).
4. Write `REVIEW.md` at the repo root; commit it only when the user asks (see the note above).

```markdown
# Review instructions
## Passes
Run three passes and tag each finding with its pass:
- Bugs: logic errors, broken edge cases, subtle regressions
- Security: injection risks, authentication gaps, PII in logs
- Compliance: the change matches spec.md, plan.md and our design principles
## What Important means here
Reserve Important for findings that would break behavior, leak data
or breach a policy. Style and naming are nits.
## Cap the nits
Report at most five nits per review; summarize the rest as a count.
## Do not report
Generated files and anything CI already enforces.
```

Hosting options: the managed Code Review service (admin enables it per repository) or the `claude-code-action` in your own CI when you need control of the pipeline or model access through your own cloud agreement (`sdlc-cicd`).

## Mode B: review a diff or PR

1. Get the diff (`git diff <base>...HEAD`, or `gh pr diff`). Read `REVIEW.md`, `CLAUDE.md`, and the change's `intent/<slug>/spec.md` and `plan.md` if present. The compliance pass depends on the committed plan, which a reviewer looking at the diff alone would not have open.
2. Run each pass in `REVIEW.md` over the full diff, citing requirement numbers (R1..) and plan steps where relevant.
3. Check that existing tests were not weakened (deleted or loosened assertions, skips, lowered thresholds, expectations rewritten without the spec calling for it; new tests are expected) and that the plan was updated if the implementation departed from it.
4. Report a table sorted by severity:

   | Severity | File:Line | Issue |
   | --- | --- | --- |
   | Important | `path:22` | Compliance: <finding, cite plan/spec> |
   | Nit | `path:8` | Bugs: <finding> |

5. Findings do not approve or block on their own. State plainly that approval is for the code owner.

## Mode C: address review comments

When tagged on a comment, make the fix and, once pushing is authorized, push it and reply on the thread with the commit so it records both the request and the change. Confirm the commit is on the remote branch before replying "Fixed". To shepherd your own PR: sweep unresolved comments and failing checks, fix, push when authorized, and repeat until green and waiting only on code-owner approval. Never approve or merge your own PR.

## Feedback into the system

- A mistake flagged a second time goes into `CLAUDE.md` in that PR (`sdlc-claude-md`).
- Flag when a change makes `CLAUDE.md` outdated.
- Monthly: rate findings, cap noisy categories in `REVIEW.md`.

## Measure

- Leading: time to first review (minutes); share of review comments resolved without a human touching the branch.
- Lagging: defects and vulnerabilities caught before merge vs escaping to production.
