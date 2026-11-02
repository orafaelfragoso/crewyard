# Agent Rail — contributor conventions

- Runtime: Bun 1.4.4 (pinned in `mise.toml`), TypeScript strict, Bun workspaces. Run commands from the repo root.
- Packages live in `packages/*` (`@agent-rail/<name>`), apps in `apps/*`. Entry is `src/index.ts`; import other packages only through their package name, never by relative path across packages. No circular package dependencies.
- Files are kebab-case. Imports of local files use the `.ts` extension.
- Domain primitives come from `@agent-rail/core`: `RailError` (stable uppercase codes + exit codes), `newId`, `nowIso`, `Clock`, `run`/`git` process helpers, `redact*`, task state machine.
- Persistence goes through `@agent-rail/storage`: `Store.immediate(fn)` wraps `BEGIN IMMEDIATE`; the callback must be synchronous. Never perform network, LLM or subprocess work inside a transaction.
- Every state change writes an event (and audit row) in the same transaction via `recordTransition`/`appendEvent`.
- External side effects (GitHub mutations, process launches, notifications) go through the outbox with an idempotency key and reconcile remote state before retrying.
- Services take a `RailContext` (`store`, `dirs`, `logger`, `clock`) as the first argument.
- Never log, print or persist secrets; credentials are references to the OS secret store.
- Code comments only when strictly necessary. Biome formats and lints (`bun run lint`), `bun run typecheck` must pass.
- Tests: `bun test`. Unit tests in `tests/unit/<package>`, contract/concurrency/integration/resilience/e2e under `tests/`. Use `tests/helpers` for temp contexts and Git repositories. Keep tests focused.
