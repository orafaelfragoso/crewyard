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

## Success criteria (PRD §2.3)

| Criterion | Evidence |
|---|---|
| 0 concurrently valid leases in a 1,000-claim multiprocess stress test | `tests/concurrency/claims.test.ts` |
| No acknowledged transition lost in 100 injected process crashes | `tests/resilience/crash-durability.test.ts` (SIGKILL, `synchronous=FULL`) |
| 0 merges outside policy; protections never bypassed | `tests/unit/integration`, `tests/integration/github-queue.test.ts` |
| 10 independent PRs integrate without author rebases | AT-03 |
| Interrupted / externally modified PRs converge | `tests/integration/github-sync.test.ts`, AT-09, AT-18 |
| Incremental indexing with provenance | `tests/unit/indexing/incremental.test.ts`, AT-19; numbers in `docs/benchmarks/method.md` |
| Identical evidence → 0 duplicate LLM reviews | AT-07 |
| Observability through CLI/TUI | `tests/unit/telemetry/metrics.test.ts` (10,000-event paging), `crew dashboard --snapshot` |
| End-to-end autonomous delivery (J-02) | `tests/e2e/pipeline.test.ts`, `tests/e2e/service-dispatch.test.ts` |

## Not yet demonstrated

- The §23.3 system demonstration against a real GitHub organization with Codex, Claude Code and OpenCode sessions has not been run; the automated suite uses a mock GitHub API, a bare Git origin and scripted agents.
- Release-tag builds (`.github/workflows/release.yml`) have not run yet; the arm64 Linux and Intel macOS runner labels it uses should be confirmed on the first tag.
