# Architecture decision records

The twelve decisions behind Agent Rail v1.0. Each is accepted; superseding one requires a new ADR.

## ADR-001: Bun and TypeScript across core and interfaces

- **Decision:** One language and runtime for domain logic, storage, CLI, MCP server and TUI.
- **Why:** Fast iteration, shared types between services and interfaces, built-in SQLite, process spawning and single-file compilation.
- **Consequences:** Release binaries are produced with `bun build --compile`. Platforms Bun cannot compile for fall back to a Bun-runtime install.

## ADR-002: SQLite in WAL mode is the local source of truth

- **Decision:** All durable state, events, audit and outbox live in one local SQLite database.
- **Why:** Embeddable, transactional, no server dependency.
- **Consequences:**
  - There is one writer at a time, so transactions stay short (`BEGIN IMMEDIATE`) and never wrap network, LLM or subprocess work.
  - The data directory must be on a local filesystem that supports WAL and locking.

## ADR-003: MCP over stdio is the required transport

- **Decision:** `rail mcp` speaks MCP over stdio, one instance per host session.
- **Why:** Works with local agent hosts without exposing any network service.
- **Consequences:** Protocol output goes only to stdout. Concurrent instances coordinate through the database. Remote MCP transports are future extensions.

## ADR-004: Skills are guidance; the core enforces rules

- **Decision:** Agent Skills describe the workflow. Leases, scopes, transitions, policy and permissions are enforced in code.
- **Why:** Prompts cannot guarantee mutual exclusion or security.
- **Consequences:** Every forbidden action is rejected at the CLI/MCP boundary, whatever the agent asks for.

## ADR-005: GitHub remains authoritative for merges and checks

- **Decision:** Merges go only through GitHub's supported paths, and observed GitHub state wins over local state.
- **Why:** Respect existing repository governance and avoid reporting success that did not happen.
- **Consequences:** No bypass of branch protection, CODEOWNERS, required reviews or checks. External edits are adopted, not reverted.

## ADR-006: No blanket automatic rebase

- **Decision:** Branches are rebased or updated only when an API or stack requirement, a conflict, a failed integration, a changed dependency or a policy makes it necessary.
- **Why:** Avoid wasted CI, invalidated approvals and repeated reviews.
- **Consequences:** Integration validates candidate trees instead of rewriting author branches.

## ADR-007: Versioned source and index evidence

- **Decision:** Every context result, review and validation is bound to a commit SHA and fingerprint.
- **Why:** Avoid stale context and unsafe reuse of review results.
- **Consequences:** Missing snapshots return `INDEX_STALE` with a recovery action rather than substituting other content.

## ADR-008: Optional resident service

- **Decision:** CLI and MCP work without a daemon. Continuous processing requires `rail service run` or an installed user service.
- **Why:** Keep installation and CLI/MCP use simple.
- **Consequences:** The UI and docs state clearly when no worker is running.

## ADR-009: Multiple provider profiles with explicit auth

- **Decision:** Agents reference account policies, never raw credentials. Several profiles per provider are allowed only through documented isolation.
- **Why:** Flexible identities without credential leakage or policy circumvention.
- **Consequences:** Fallback between profiles is opt-in and never used to evade rate limits.

## ADR-010: Service boundaries independent of UI

- **Decision:** Application services have no UI dependencies and return plain data.
- **Why:** Reuse in a future native Rust/GPUI desktop app through local IPC.
- **Consequences:** See [desktop integration](architecture/desktop-integration.md).

## ADR-011: Conservative default merge policy

- **Decision:**
  - Default autonomy is `guarded`.
  - Approval gates apply to security-sensitive, migration and deployment paths.
  - Autonomy never exceeds explicit operator and GitHub permissions.
- **Why:** Mistakes in merges are expensive; operators opt in to more autonomy.
- **Consequences:** `observe` and `assisted` cannot enable auto-merge, and high-risk work waits for approval.

## ADR-012: Native merge queue when supported, safe fallback otherwise

- **Decision:**
  - Use GitHub's merge queue (with `merge_group` checks) when the repository has it.
  - Otherwise, serialize admission per base branch, and merge through branch-protected APIs after re-reading base and head SHAs.
- **Why:** Avoid reimplementing what GitHub provides while still serving repositories without a queue.
- **Consequences:** When the host cannot attest required checks for the exact integrated result, the candidate is labeled "not yet integration-validated".
