# Review process: scaling human review by risk

Status: **proposal**. The code owners in [`.github/CODEOWNERS`](../../.github/CODEOWNERS) accept, reshape, or close it. Origin: issue #257. Modeled on Anthropic's [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/), adapted to this repository.

## Goal

Spend the least human review time that does not raise reverts or incidents. Ask of each change "what could go wrong, and which check, automated or human, is the right one to catch it?" rather than "did a human read every line?"

- **Measure human time:** approvals per PR (median and 95th percentile), human review comments, and how long a PR waits on a person.
- **Guardrails:** the revert rate and the incident rate. If either rises, human time was moved, not saved, and the tiers below tighten again.

## Problem

Agent-written pull requests arrive faster than a person can read each one, and today every PR gets the same review whatever it touches: a README typo and a change to the release workflow receive the same attention. Meanwhile the `main` ruleset requires no approval at all (see [Settings](#settings-and-their-current-state)), so the human gate depends on habit, not enforcement.

## Layers

Each layer catches what the one before it misses. Only the last needs a person by default.

1. **Verification before the PR.** `pnpm ci:local`, the edit-time hooks in `.claude/hooks/`, and a fresh-context review (`/code-review`, `/security-review`, or the `verifier` subagent), with command output shown, not claimed. See [REVIEW.md](../../REVIEW.md#where-review-runs).
2. **AI review on every PR.** The `REVIEW.md` passes and a separate security pass in [claude-review.yml](../../.github/workflows/claude-review.yml), plus Copilot review. Findings are inline and tagged Important / Nit / Pre-existing; nothing approves.
3. **Blocking checks.** CI on Linux, macOS, and Windows, the security workflow, the changelog check, and every review thread resolved.
4. **Risk-based human approval** (below).
5. **Merge queue and staged release.** A merge queue re-runs the checks against `main` with the change applied. Releases go out as a `vX.Y.Z-rc.N` prerelease first, which does not move the floating `vN` tag, then as a stable tag that does (see [RELEASE.md](../../RELEASE.md)).
6. **Detection and rollback.** A bad release is rolled back in one step by moving `vN` to the previous tag (RELEASE.md manual fallback). Each revert or incident is reviewed for which layer should have caught it, and the answer lands in `REVIEW.md`, [review-lessons.md](review-lessons.md), a skill, or a new check.

## Risk tiers

The change sets the tier, not the author. A path rule (and the Risk section of the PR template) assigns it; any one path in a higher tier lifts the whole PR.

| Tier | Touches | Human approvals |
| --- | --- | --- |
| Low | Docs other than the policy files below, comments, tests only, changelog fragments | None once AI review, security review, and CI are green and every thread is resolved; trusted authors only |
| Medium | `src/` behavior, inputs or outputs, dependencies, `dist/` | One code owner |
| High | Always-human paths (below), breaking `action.yml` changes, SDK major bumps | Two people, one a code owner who did not author or prompt the change, with a plan in `docs/exec-plans/active/` first |

**Always-human paths**, whatever else the diff contains:

- Workflows and automation: every file under `.github/workflows/` and `.github/actions/`, and `.claude/` (hooks are executable configuration that runs on contributors' machines).
- Review, authorization, and security policy, because they steer the reviewer or define what it checks: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `REVIEW.md`, `SECURITY.md`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `docs/design-docs/conventions.md`, `docs/design-docs/review-process.md`, and `docs/design-docs/review-lessons.md`.
- The gates themselves: `scripts/changelog-check*.mjs`, `scripts/claude-review-gate*.mjs`, and `scripts/check-release-provenance-policy.mjs`.
- Release and credentials: `RELEASE.md`, `.changie.yaml`, `scripts/changelog-release.mjs`, and the credential and masking code in `src/inputs.ts`, `src/client.ts`, and `src/errors.ts`.

A change to the policy is judged against the trusted base-branch policy, not against the version it proposes: `claude-review.yml` reviews with the base branch's `REVIEW.md`, `AGENTS.md`, and `review-lessons.md` and flags any weakening as Important.

Rules that hold at every tier:

- **Trusted authors only.** The lighter paths apply to authors on a written trusted list (the owning team). Everyone else needs a code owner's approval.
- **Bot approvals never count.** Copilot, Claude, and any other automation post findings; they cannot fill a slot that requires a human.
- **The person directing an agent is a reviewer.** On an agent-written PR, the person who prompted it counts as one of the required people and must read the evidence.
- **Approval is per commit.** A new commit the process cannot vouch for (an agent's push, a hand-resolved merge) dismisses earlier approvals.

## Review effort by tier

Match AI review depth to risk: Quick for Low, Standard for Medium, Deep for High, where one missed bug costs more than the extra review time. Cap review at three rounds, re-review only the new diff after the first few passes, never repeat a posted finding, and flag the bug class so every instance is fixed in one round (all in [REVIEW.md](../../REVIEW.md#convergence)).

## Improving the reviewer

- **Incidents and reverts become evals.** Collect the PRs that caused a revert or a real bug, with their fixes, as a regression set for the reviewer: for example the cross-bucket `copyLargeFile` bucket bug, the `keep-days` window never forwarded, governance deletes, the prerelease version rollback, and the fail-open approval gate. Re-score the reviewer on that set whenever its prompt, tools, or model change, and keep only changes that raise the score. This needs the evals-in-CI decision in #257.
- **Measure noise by the author's response.** Sort every review comment by what the author did: fixed it, said it was wrong, said it was intentional, or decided it did not matter. [review-lessons.md](review-lessons.md) did this once for all merged PRs (192 findings: 186 fixed, 4 rebutted, 2 without a reply, snapshot 2026-10-28) and records the method and definitions; repeat it each quarter with the same method.
- **Scan existing code on a schedule.** A periodic review agent over the whole repository finds bugs that predate any diff (most repeat findings turn out to be old code). Deferred until the API key and budget are decided.

## Activation prerequisites

Code and evidence that must land before an admin turns on the matching setting. Turning a setting on first breaks merges or enforces something unproven.

1. **Merge queue.** No workflow has a `merge_group` trigger today, so required checks would never report for a queued merge and every queued PR would stall. First add `merge_group` to the deterministic required workflows (`ci.yml`, `security.yml`, `docs-lint.yml`); audit their job conditions and steps for assumptions about the `pull_request` payload (`github.event.pull_request.*`, `github.base_ref`); and decide how PR-only checks are represented, since the changelog fragment check and both Claude review jobs are about the PR rather than the merged result (either not required for the merge group, or made to report for it). Do not add `merge_group` to secret-bearing example workflows or to the review jobs. Validate with one queued PR before requiring the queue.
2. **Tier-based approvals.** Add tests that classify representative paths into Low, Medium, High, and always-human (including the policy files above) before approvals start depending on the tier.
3. **Claude review as a required check.** Run both passes for real on several PRs once `ANTHROPIC_API_KEY` exists, including a PR with an already resolved finding and a later push, and confirm the token can post inline comments. Until then the jobs pass by skipping, which proves nothing.

## Settings and their current state

What a repository admin would change to enforce this. State read from the active `main` ruleset on 2026-10-27.

| Setting | Today | Proposed |
| --- | --- | --- |
| Block deletion and force-push, linear history | On | Keep |
| Copilot review on every push, including drafts | On | Keep, or limit to ready PRs to cut repeat passes on old commits |
| Required approvals and code-owner review | Off | On, with the tiers above |
| Dismiss stale approvals; require approval of the last push | Off | On |
| Required status checks | Off | CI, security, and changelog now; add both Claude review jobs only after they have run for real on several PRs (until the key exists they pass by skipping, so a green check proves nothing) |
| Require conversation resolution | Off | On |
| Merge queue | Off | On, after activation prerequisite 1 |
| `ANTHROPIC_API_KEY` repository secret | Absent, so `claude-review.yml` skips | Add, to enable AI and security review |
| `skip-changelog` label | Absent | Create |

## Where humans stay

Deciding whether a change should exist at all; reviewing risky code (release, credentials, CI); reviewing architecture others will copy; reading the evidence before approving; and owning every shipped change. "You land it, you own it": the author fixes their own post-merge problems, and incident reviews examine the system, not the person.

## Open questions

- Who is on the trusted-author list, and who besides the default code owners may give a High tier second approval?
- Should the tier be declared in the PR template, inferred from paths by a check, or both?
- Which revert and incident data source feeds the guardrail metrics?
