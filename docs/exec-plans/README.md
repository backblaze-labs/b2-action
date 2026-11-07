# Execution plans

Plans are first-class, versioned artifacts. Small changes need no plan — just a good PR. Complex
or multi-step work gets a checked-in plan so its intent, progress, and decisions travel with the
repo instead of living in someone's head.

## Layout

- `active/` — plans in flight. One file per plan, named `NNNN-short-slug.md` (zero-padded id).
  Keep a short decision log at the bottom as choices are made.
- `completed/` — shipped plans, moved here for history. Do not delete them; they explain why the
  code looks the way it does.
- [`tech-debt-tracker.md`](tech-debt-tracker.md) — the running list of known, deliberate
  deferrals so they surface instead of rotting.

## Writing a plan

Keep it lightweight: the goal and acceptance criteria, the steps as a checklist, and a decision
log. Link the issues, the docs it touches, and the gates that will prove it done. When it ships,
move the file to `completed/` and note the outcome. Pay debt down in small increments; log
anything you defer in the tracker with an id, severity, and date.
