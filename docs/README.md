# Documentation (system of record)

This directory is the system of record for `b2-action`: the durable "why" behind the code, the
plans in flight, and the quality bar. Code that disagrees with a doc here is a bug in one of them.

Start at the repository map in [AGENTS.md](../AGENTS.md) and the layering rules in
[ARCHITECTURE.md](../ARCHITECTURE.md). Then, within this tree:

- [design-docs/index.md](design-docs/index.md) — the catalog of design docs, with a verification
  status per entry.
  - [design-docs/core-beliefs.md](design-docs/core-beliefs.md) — how we work in this repo.
  - [design-docs/conventions.md](design-docs/conventions.md) — commit, style, CI, and git policies.
- [exec-plans/README.md](exec-plans/README.md) — plans as first-class artifacts, plus the
  [tech-debt tracker](exec-plans/tech-debt-tracker.md).
- [QUALITY_SCORE.md](QUALITY_SCORE.md) — per-area health grades and tracked gaps.
- [references/README.md](references/README.md) — external stack and tooling references.

Keep docs concise and cross-linked: say a thing once, then link instead of repeating. A giant doc
is an attractive nuisance nobody maintains, and every token here competes with the task in front
of the agent. If a rule can be enforced in code, promote it into code.
