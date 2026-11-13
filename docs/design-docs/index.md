# Design docs index

The catalog of design docs for `b2-action`. Each row carries a **verification status** so a
reader knows whether to trust it. Update the status and review date when you touch a doc, and
mark an entry `Superseded` (with a pointer) rather than deleting its history from memory.

Status legend:

- **Current** — matches the code and the team's intent as of the review date.
- **Stale** — likely out of date; verify against the code before relying on it.
- **Superseded** — replaced by another doc; kept only for history.
- **Proposal**: not yet accepted; read it as a suggestion, not policy.

| Doc | Status | Last reviewed | What it covers |
| --- | --- | --- | --- |
| [core-beliefs.md](core-beliefs.md) | Current | 2026-08-27 | Agent-first operating principles for this repo |
| [conventions.md](conventions.md) | Current | 2026-08-27 | Commit, code-style, CI-actor, and git-history policies |
| [review-lessons.md](review-lessons.md) | Current | 2026-10-27 | Recurring review findings from all merged PRs, as a pre-PR checklist |
| [review-process.md](review-process.md) | Proposal | 2026-10-27 | Review layers, risk tiers, approval rules, metrics, and required settings; awaiting a code-owner decision |

Top-level structure lives outside this catalog by design, so it stays easy to find:
[AGENTS.md](../../AGENTS.md) is the map, and [ARCHITECTURE.md](../../ARCHITECTURE.md) holds the
layers and boundary invariants.
