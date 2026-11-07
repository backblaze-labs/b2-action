# Tech-debt tracker

Known, deliberate deferrals. Logging them here keeps them visible so they get paid down in small
increments instead of rotting. Add a row when you defer something on purpose; close it (mark
`Resolved` with the date) when it lands. Severity is the cost of leaving it, not the effort to fix.

| ID | Severity | Opened | Status | Item |
| --- | --- | --- | --- | --- |
| TD-0001 | Medium | 2026-08-27 | Open | Mutation testing runs weekly/manual only, not as a per-PR gate, while survivors are triaged. |
| TD-0002 | Low | 2026-08-27 | Open | The `resume` input is reserved and not yet honored. |
| TD-0003 | Low | 2026-08-27 | Open | No pinned lychee binary for Intel macOS (`darwin-x64`). |
| TD-0004 | Low | 2026-08-27 | Open | Key architecture edges are test-enforced; a full layer-graph linter is not yet in place. |
| TD-0005 | Low | 2026-08-27 | Open | No scheduled doc-staleness / gardening scan (structural drift is test-enforced; freshness is not). |

## Details

- **TD-0001 — Mutation gate is scheduled-only.** The batched Stryker run enforces a `break: 65`
  aggregate threshold against a 72.83% baseline, on a weekly/manual cadence rather than per PR,
  because survivor triage is still in progress. Tighten the threshold toward the baseline (or add a
  non-blocking PR information run) once survivors are paid down. See
  [DEVELOPMENT.md → Mutation testing](../../DEVELOPMENT.md#mutation-testing).

- **TD-0002 — `resume` input is reserved.** The streaming upload source is non-sliceable, so a
  retry currently does a full re-upload; the input is kept in the surface so it can light up if a
  `BufferSource` fallback ships. See the `resume` row in
  [README → Inputs](../../README.md#inputs-full-reference).

- **TD-0003 — Intel macOS lychee gap.** Lychee `0.23.0` publishes no `darwin-x64` binary, so
  `pnpm docs:links` cannot run locally on Intel Macs; those contributors rely on the CI
  `link-check` job. Revisit when lychee ships an Intel asset or the pin moves. See
  [DEVELOPMENT.md → Managed lychee binary](../../DEVELOPMENT.md#managed-lychee-binary).

- **TD-0004 — Layer/dependency enforcement.** [`__tests__/architecture.test.ts`](../../__tests__/architecture.test.ts)
  now enforces the key edges in [ARCHITECTURE.md](../../ARCHITECTURE.md#boundary-invariants): all B2
  I/O goes through the SDK (no raw transport or `fetch`), the dispatcher (not commands) owns outputs,
  and commands never depend upward. The residual gap is a full layer-graph linter that checks every
  allowed edge with a remediation message; the current test covers the highest-risk boundaries.

- **TD-0005 — No doc-gardening scan.** Structural drift (orphan docs, a missing harness pointer,
  an over-long `AGENTS.md`, an incomplete index) is now caught by
  [`__tests__/docs-structure.test.ts`](../../__tests__/docs-structure.test.ts). The remaining gap is
  *freshness*: the manual `Last reviewed` dates in [the design-doc index](../design-docs/index.md)
  and [quality score](../QUALITY_SCORE.md) have no scheduled job flagging stale docs or opening
  fix-up PRs (the blueprint's continuous garbage collection). A periodic staleness scan would close it.
