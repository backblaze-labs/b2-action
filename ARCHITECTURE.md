# Architecture

The top-level map of how `b2-action` is structured and the invariants that keep it coherent as
it grows. This is the **rules** of the architecture; the operational walkthrough (with a data-flow
diagram) is in [DEVELOPMENT.md → How it works](DEVELOPMENT.md#how-it-works), and every local
command and CI gate is in [DEVELOPMENT.md](DEVELOPMENT.md).

## One domain, layered

The Action is a single domain: turn one workflow step into one B2 operation. Code flows forward
through fixed layers, top to bottom. A module may depend on the layers below it in this table,
never the reverse.

| Layer | Files | Responsibility |
| --- | --- | --- |
| Entrypoint | `src/main.ts` | Parse → build client → dispatch on `inputs.action` → map result to outputs; turn any throw into `core.setFailed` |
| Input | `src/inputs.ts`, `src/sse.ts`, `src/fs.ts` | Read and validate `INPUT_*` env vars, apply the credential-fallback chain, mask secrets, expand paths |
| Client | `src/client.ts` | Construct and authorize the `B2Client`, mask the auth token, resolve the target `Bucket` |
| Command | `src/commands/<verb>.ts` (13 verbs) | One verb per file; do the work via the SDK, report progress, return a typed result. `delete-all.ts` is a shared bulk-delete helper, not a verb |
| Reporting | `src/outputs.ts`, `src/summary.ts`, `src/format.ts`, `src/progress.ts`, `src/errors.ts` | Shape outputs and `summary-json`, render the step summary, format bytes/durations, normalize errors |
| Provider boundary | [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript) | The single external interface for all B2 wire-protocol work |

## Boundary invariants

These are the "allowed edges." Breaking one is the kind of drift that mechanical checks and
reviews exist to catch.

- **All B2 I/O goes through the SDK.** No module performs raw HTTP, `fetch`, CLI, or subprocess
  calls to B2. The SDK is the one provider boundary, analogous to a single cross-cutting interface:
  swap-in points (transport, simulator) live there, not scattered through commands.
- **Inputs are parsed once, at the boundary.** `src/inputs.ts` is the only reader of `INPUT_*`
  env vars. Everything downstream consumes the typed `ParsedInputs`; nothing re-reads or re-guesses
  raw env. New inputs are validated here, with a clear error when missing or malformed.
- **The dispatcher owns outputs.** Commands return typed results and never call `core.setOutput`.
  `src/main.ts` maps each result to `core.setOutput(...)` and `writeStepSummary(...)`. This keeps
  the output contract in one place, next to the code that must stay in sync with `action.yml`.
- **Secrets are masked where they enter.** The `application-key` and auth token are masked in the
  input/client layer; presigned URLs are masked before they leave a command. Secret-bearing fields
  are stripped from `summary-json` by name.
- **`dist/` is generated, never authored.** `src/` is the source of truth; `dist/index.js` is the
  `ncc` bundle GitHub runs directly. See [DEVELOPMENT.md](DEVELOPMENT.md#why-dist-is-committed).

The SDK-boundary, dispatcher-owns-outputs, and forward-only dependency edges above are enforced by
[`__tests__/architecture.test.ts`](__tests__/architecture.test.ts); a violation fails CI.

## Taste invariants

Encoded once, applied everywhere. Most are enforced in CI (see
[DEVELOPMENT.md → CI gates](DEVELOPMENT.md#ci-gates)):

- **Style** — Biome: 2-space indent, single quotes, no semicolons, 100-column width;
  `exactOptionalPropertyTypes` and `verbatimModuleSyntax` on; internal imports use `.ts`.
- **Layout** — one verb per `src/commands/<verb>.ts`; tests colocated under `__tests__/` and run
  against the SDK's in-memory `B2Simulator`, never a network.
- **Identity** — the `b2-sdk-typescript/` and `b2-github-action/` User-Agent tokens are stable
  product identifiers; `src/version.ts` reads the version from `package.json`, so bump it in one
  place (`package.json`) and never hardcode a version literal.
- **Docs contract** — every input/output in `action.yml` also appears in the README reference
  tables (`sync-check`), and every exported symbol carries TypeDoc-checked JSDoc.

## Adding a verb

The layered flow above is why adding a verb is a fixed recipe (implement in `commands/`, register
in `inputs.ts`, dispatch in `main.ts`, document in `action.yml` + README, test against the
simulator, add an example workflow, rebuild `dist/`). The full checklist is in
[CONTRIBUTING.md → Adding a new verb](CONTRIBUTING.md#adding-a-new-verb) and
[DEVELOPMENT.md → Step-by-step: adding a new verb](DEVELOPMENT.md#step-by-step-adding-a-new-verb).
