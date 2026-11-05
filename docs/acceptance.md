# Acceptance matrix

How each PRD release gate is exercised. Run everything with `bun test`. CI is configured to run the suites on Linux, macOS and Windows for pull requests, merge groups and pushes to `main`. Configured jobs are not evidence that a platform run has passed; record the actual runner results before claiming platform acceptance.

## Mandatory scenarios (PRD §23.2)

| ID | Scenario | Test |
|---|---|---|
| AT-01 | 10 agents claim the same READY task | `tests/concurrency/claims.test.ts` (10 processes, one shared SQLite file) |
| AT-02 | Agent crashes after writing changes | `tests/resilience/lease-recovery.test.ts`, `tests/integration/workspaces.test.ts` |
| AT-03 | 10 independent PRs queued | `tests/integration/github-queue.test.ts` |
| AT-04 | Two PRs touch the same interface | `tests/integration/github-queue.test.ts` |
| AT-05 | Three stacked PRs | `tests/integration/github-queue.test.ts` |
| AT-06 | Base advances during candidate validation | `tests/integration/github-queue.test.ts` |
| AT-07 | Same patch reviewed twice with unchanged context | `tests/unit/reviews/reviews.test.ts` |
| AT-08 | Unchanged patch with changed relevant schema | `tests/unit/reviews/reviews.test.ts` |
| AT-09 | GitHub API times out after the merge request | `tests/resilience/github-merge-timeout.test.ts` |
| AT-10 | Review/CI failure repeats | `tests/integration/github-queue.test.ts` |
| AT-11 | Branch protections change | `tests/integration/github-queue.test.ts` |
| AT-12 | Host goes offline | `tests/integration/github-sync.test.ts` |
| AT-13 | Two MCP hosts + CLI mutate the queue concurrently | `tests/integration/github-queue-concurrency.test.ts` |
| AT-14 | Lease expires while the old process is alive | `tests/unit/tasks/leases.test.ts`, `tests/resilience/lease-recovery.test.ts` |
| AT-15 | Malicious instruction in the repository README | `tests/contract/mcp.test.ts` (no administrative tools, anonymous callers read-only, tokens never exposed), `tests/unit/host-installers/skills.test.ts` |
| AT-16 | Install/uninstall on supported hosts | `tests/contract/host-installers.test.ts` |
| AT-17 | Account unavailable or rate-limited | `tests/unit/agents/routing.test.ts`, `tests/integration/agents-sessions.test.ts` |
| AT-18 | Service restarted during outbox execution | `tests/resilience/github-merge-timeout.test.ts` |
| AT-19 | Context request for a branch-specific SHA | `tests/integration/indexing-freshness.test.ts` |
| AT-20 | Metrics across mixed provider adapters | `tests/unit/telemetry/metrics.test.ts`, `tests/unit/providers/adapters.test.ts` |

## Durable execution and evidence

| Contract | Local evidence |
|---|---|
| Cross-process claims, stale-owner refusal and bounded SQLite acquisition | `tests/concurrency/execution-claims.test.ts`, `tests/unit/storage/execution-claims.test.ts` |
| Atomic review joining with current source/context/policy acceptance | `tests/concurrency/review-admission.test.ts`, `tests/unit/reviews/source-evidence.test.ts`, `tests/integration/integration-review-context.test.ts` |
| Unrelated progress during held validation, capacity-one fairness and leadership after SQLite contention | `tests/e2e/service-execution.test.ts` |
| Direct CLI/MCP, packaged workers, process drain, cancellation before/after provider launch and preserved work | `tests/e2e/direct-execution.test.ts`, `tests/e2e/execution-workers.test.ts`, `tests/e2e/execution-recovery.test.ts` |
| Exact-commit index ownership, reader/GC barriers and shared-extraction invalidation | `tests/concurrency/index-execution.test.ts`, `tests/unit/indexing/execution.test.ts` |
| Renewable recovery delivery, cancellation during bootstrap and exact task-generation preservation | `tests/e2e/execution-cleanup-lease.test.ts` |
| Every exposed prefix, first-delivery/retry mutation guards and reconciled task hooks | `tests/integration/integration-prefixes.test.ts`, `tests/resilience/integration-mutation-guards.test.ts`, `tests/resilience/integration-hooks.test.ts` |
| Actual-target post-merge health and deduplicated draft repairs | `tests/unit/application/post-merge.test.ts` |
| Immutable exact-OID fetch sharing, dead-owner recovery and remote identity refusal | `tests/concurrency/fetch.test.ts` |
| Predecessor upgrades, legacy open-writer fencing and immutable cache-body identity | `tests/unit/storage/migrations.test.ts`, `tests/unit/integration/cache-fencing.test.ts` |
| Atomic workspace allocation and merged-head publication evidence after remote branch deletion | `tests/integration/workspaces.test.ts` |
| Metrics v2 local/hosted timing, active joins and monotonic operation observations | `tests/unit/telemetry/metrics.test.ts` |

## Success criteria (PRD §2.3)

| Criterion | Evidence |
|---|---|
| 0 duplicate concurrently valid leases for one task in a 1,000-claim multiprocess stress test | `tests/concurrency/claims.test.ts` |
| No acknowledged transition lost in 100 injected process crashes | `tests/resilience/crash-durability.test.ts` (SIGKILL, `synchronous=FULL`) |
| 0 merges outside policy; protections never bypassed | `tests/unit/integration`, `tests/integration/github-queue.test.ts` |
| 10 independent PRs integrate without author rebases | AT-03 |
| Interrupted / externally modified PRs converge | `tests/integration/github-sync.test.ts`, AT-09, AT-18 |
| Incremental indexing with provenance | `tests/unit/indexing/incremental.test.ts`, AT-19; numbers in `docs/benchmarks/method.md` |
| Current admissible identical evidence reuses completed reviews or joins active work | AT-07, review-admission concurrency tests; crashes can repeat provider work |
| Observability through CLI/TUI | `tests/unit/telemetry/metrics.test.ts` (10,000-event paging), `crew dashboard --snapshot` |
| End-to-end autonomous delivery (J-02) | `tests/e2e/pipeline.test.ts`, `tests/e2e/service-dispatch.test.ts` |

## Recorded local verification

On 2026-11-05, merged source commit `f4fd274` passed `bun test` on Linux: **463 passed, 0 failed**, 2,316 assertions
across 81 files (103.84 s). `bun run typecheck`, `bun run lint` and `git diff --check` also passed. These are local
results for that commit, not authenticated provider, real GitHub or cross-platform release acceptance.

The final disk-backed 50,101-file run used SQLite WAL with `FULL` durability: 48.129 s cold, 5.150 s for 100 changed
files, 64.4 ms hybrid-search p95 (200 queries) and 85.5 ms context-pack p95 (50 packs). Both declared latency budgets
passed. Membership remains O(N); unpaired measurements on a shared host establish no speedup percentage.
The [benchmark method](benchmarks/method.md#remediation-baseline-and-experiment-decisions-2026-11-05) records
sample sizes, variance, resource use and rejected experiments.

## Not yet demonstrated

- The §23.3 system demonstration against a real GitHub organization with Codex, Claude Code and OpenCode sessions has not been run; the automated suite uses a mock GitHub API, a bare Git origin and scripted agents.
- Native merge-queue entitlement, repository protections and required checks executing on a real merge-group SHA remain release gates. Local fixtures and workflow configuration do not establish those host guarantees.
- Packaged worker execution is tested locally on Linux. Actual macOS and Windows worker/CI results must be recorded before claiming those platforms accepted.
- Release-tag builds (`.github/workflows/release.yml`) have not run yet; the arm64 Linux and Intel macOS runner labels it uses should be confirmed on the first tag.
