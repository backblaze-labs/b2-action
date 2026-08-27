# GEMINI.md

This repository is multi-harness. The canonical, tool-agnostic guidance for every AI assistant
lives in **[AGENTS.md](AGENTS.md)** — read it first. This file exists only so Gemini lands on the
same map instead of a separate copy that drifts out of date.

## Gemini notes

- Follow [AGENTS.md](AGENTS.md) and its pointers: the golden rules, the `pnpm all` gate, and the
  system of record under [docs/](docs/README.md).
- Two rules bear repeating because they are easy to trip:
  - **Never mutate git history** (no commits, pushes, rebases, or PR creation) unless the user
    explicitly asks in the current turn. The authoritative command list and policy is in
    [conventions](docs/design-docs/conventions.md).
  - **Rebuild `dist/`** with `pnpm build` after any `src/` change and keep it diff-clean; CI fails
    on drift.
- Put durable guidance in [AGENTS.md](AGENTS.md) or [docs/](docs/README.md), not here.
