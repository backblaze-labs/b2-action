# Review process: scaling human review by risk

Status: **proposal**. The code owners in [`.github/CODEOWNERS`](../../.github/CODEOWNERS) accept, reshape, or close it. Origin: issue #257.

## Problem

Agent-written pull requests arrive faster than a person can read each one line by line, and today every PR gets the same review whatever it touches. A README typo and a change to the release workflow receive the same attention, so review time is spent evenly instead of where a mistake is expensive.

## Proposed outcome

Tie review depth to risk.

| Tier | Touches | Review |
| --- | --- | --- |
| Low | Docs, comments, tests only, example workflows | One code owner; an AI review pass is optional |
| Medium | `src/` behavior, inputs or outputs, dependencies | The [REVIEW.md](../../REVIEW.md) passes, then one code owner; a changelog fragment is required |
| High | `release.yml`, `security.yml`, breaking `action.yml` changes, credential handling, `dist/` packaging, SDK major bumps | The REVIEW.md passes plus a security review, a plan in `docs/exec-plans/active/` first, then a code owner who did not author the change |

Supporting settings, each a separate decision:

- Dismiss stale approvals when new commits are pushed.
- Require conversation resolution before merge.
- Run the REVIEW.md passes automatically on every PR (managed Code Review or `claude-code-action`).
- Turn every escaped defect into a regression test, and into an eval once evals exist.
- Track time to first review, review rounds per PR, and defects found after merge.

## Constraints

- Branch protection on `main` keeps a human code-owner approval at every tier. The author agent never approves its own change.
- No new repository secrets until the evals-in-CI decision in #257 is made.

## Open questions

- Who besides the default code owners may approve a High tier change?
- Should the tier be declared in the PR template, or inferred from the paths a change touches?
