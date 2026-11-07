# Core beliefs

How we work in `b2-action`. These are operating principles, not code; they explain the intent
behind the [golden rules in AGENTS.md](../../AGENTS.md#golden-rules-invariants) and the
[boundary invariants in ARCHITECTURE.md](../../ARCHITECTURE.md#boundary-invariants).

- **Humans steer; agents execute.** People set priorities, translate feedback into acceptance
  criteria, and validate outcomes. The mechanical work of writing and checking code is delegated.

- **The SDK is the source of truth for B2.** Behavior at the wire is owned by
  [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript). When you would
  reach for raw HTTP or a CLI, add or use an SDK capability instead. This Action stays a thin,
  legible dispatcher.

- **When the agent struggles, add the missing capability — don't "try harder."** A failure is a
  signal that a tool, guardrail, or doc is missing. Fix the environment (a lint with a remediation
  message, a helper, a doc pointer), then let the change flow through the normal gates.

- **If it isn't in the repo, it doesn't exist.** Knowledge that lives only in someone's head or a
  chat thread is invisible to the next run. Push context into versioned files here: design notes,
  plans, decisions, quality grades.

- **Enforce invariants mechanically, not by reminder.** Prefer a check that fails with a clear fix
  over a paragraph asking people to remember. The [CI gates](../../DEVELOPMENT.md#ci-gates) —
  `action.yml` ↔ README sync, coverage, mutation, dist freshness, link/spell/markdown lints,
  supply-chain audits — are the enforcement surface. Promote a rule into code when a doc falls short.

- **Prefer boring, well-understood technology.** Depend on things an agent can fully reason about
  in-repo. Keep in-repo helpers small, observable, and well covered (see the managed lychee runner
  and its tests) rather than pulling opaque behavior you cannot inspect.

- **Docs are maps, not manuals.** Context is scarce; verbose prose is a cost, not thoroughness.
  Say it once, link the rest, and cut hedging. Too much guidance becomes no guidance.

- **`dist/` correctness is proven, not asserted.** The bundle is generated. Trust `pnpm all` and
  CI, not a hand edit. See [why `dist/` is committed](../../DEVELOPMENT.md#why-dist-is-committed).

- **Pay tech debt down continuously.** Log deferrals in the
  [tech-debt tracker](../exec-plans/tech-debt-tracker.md) so they surface instead of rotting, and
  keep the [quality grades](../QUALITY_SCORE.md) honest.
