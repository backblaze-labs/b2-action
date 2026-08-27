# Tech-debt tracker

Known, deliberate deferrals. Logging them here keeps them visible so they get paid down in small
increments instead of rotting. Add a row when you defer something on purpose; close it (mark
`Resolved` with the date) when it lands. Severity is the cost of leaving it, not the effort to fix.

| ID | Severity | Opened | Status | Item |
| --- | --- | --- | --- | --- |
| TD-0001 | Medium | 2026-08-27 | Open | Mutation testing runs weekly/manual only, not as a per-PR gate, while survivors are triaged. |
| TD-0002 | Low | 2026-08-27 | Open | The `resume` input is reserved and not yet honored. |
| TD-0003 | Low | 2026-08-27 | Open | No pinned lychee binary for Intel macOS (`darwin-x64`). |
| TD-0004 | Low | 2026-08-27 | Open | No automated layer/dependency linter enforcing the architecture edges. |
| TD-0005 | Low | 2026-08-27 | Open | No scheduled doc-staleness / gardening scan; doc freshness relies on manual review. |

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

- **TD-0004 — No mechanical layer linter.** The dependency edges in
  [ARCHITECTURE.md](../../ARCHITECTURE.md#boundary-invariants) are currently enforced by review and
  structural tests, not a custom linter that fails the build with a remediation message. A small
  import-direction check would make the boundary self-enforcing.

- **TD-0005 — No doc-gardening scan.** Design-doc freshness relies on the manual `Last reviewed`
  dates in [the design-doc index](../design-docs/index.md) and [quality score](../QUALITY_SCORE.md);
  there is no scheduled job that flags stale docs or opens fix-up PRs (the blueprint's continuous
  garbage collection). A periodic drift scan would keep this system of record honest without polling.
