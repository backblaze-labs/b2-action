# Quality score

A grade per area, with the evidence behind it and the gap that keeps it from an A. This is a
snapshot for tracking drift over time, not a marketing sheet: keep it honest and re-grade when the
evidence moves. Open gaps should have a row in the
[tech-debt tracker](exec-plans/tech-debt-tracker.md).

Grades: **A** solid, **B** good with a known gap, **C** works but needs investment.

| Area | Grade | Evidence | Gap |
| --- | --- | --- | --- |
| Unit-test coverage | A | ~98% statements / 96% branches / 100% functions / 99% lines, above the 95/85/100/95 gate ([DEVELOPMENT.md](../DEVELOPMENT.md#coverage)) | None material |
| Mutation coverage | C | 72.83% aggregate against a `break: 65` gate; command targets at 62.59% ([DEVELOPMENT.md](../DEVELOPMENT.md#mutation-testing)) | Survivors not yet triaged; gate is scheduled-only (TD-0001) |
| Architecture legibility | B | One SDK provider boundary, forward-only layers, one verb per file ([ARCHITECTURE.md](../ARCHITECTURE.md)) | Edges enforced by review, not a linter (TD-0004) |
| Docs & legibility | A | `action.yml` ↔ README sync, strict TypeDoc, markdown/link/spell lints, a docs-structure test, and the AGENTS.md map over this system of record ([DEVELOPMENT.md](../DEVELOPMENT.md#ci-gates)) | Structure is test-enforced; freshness still relies on review, with no scheduled gardening scan (TD-0005) |
| Supply chain & release | A | SHA-pinned actions, prod + full-lockfile audits, release-provenance policy, attested `dist/` ([DEVELOPMENT.md](../DEVELOPMENT.md#ci-gates), [RELEASE.md](../RELEASE.md)) | None material |
| Reliability & smoke | A | Daily and weekly real-B2 smoke plus example workflows that double as an integration suite ([.github/workflows/README.md](../.github/workflows/README.md)) | None material |

## How grades are set

A grade is only as good as its evidence link. When you change a gate, coverage number, or
enforcement mechanism, update the row and the review date below. Prefer moving a grade because the
mechanical evidence changed, not because it feels better.

Last reviewed: 2026-08-27.
