# Index and retrieval benchmark method

Script: `scripts/bench-index.ts`. It measures what PRD §2.3 asks for: cold indexing time, a 100-file
incremental update, and indexed search latency (p50/p95). LLM, embedding and GitHub latency are excluded; no
embedding provider is configured.

```sh
bun scripts/bench-index.ts --files 50000 --queries 200 --workdir ~/.cache/crew-bench   # synthetic repository
bun scripts/bench-index.ts --repo /path/to/repo --queries 50                            # existing repository (cold + latency)
```

Options: `--files N` (synthetic size, default 5000), `--changed N` (incremental size, default 100), `--queries N`,
`--durability full|normal` (default `full`, the release setting), `--workdir DIR` (where the temporary repository
and database live; the default is the OS temp dir, which is `tmpfs` on many Linux systems and hides fsync cost),
`--json`, `--keep`.

## Procedure

1. Generate a repository (or use `--repo`): 60 % TypeScript modules with cross-package relative imports, 20 %
   Python, 10 % Rust, 10 % Markdown, 50 `package.json` workspace packages, committed in one commit.
2. Open a fresh database in a temporary data directory, register the repository, and run `indexRepository` on
   the base branch. The measured cold time includes tree-sitter WASM initialisation, `git ls-tree`, streaming all
   blobs through `git cat-file --batch`, parsing, redaction, FTS insertion and the final availability transaction.
3. Synthetic only: append a function to 100 source files spread across the tree, commit, and index the new commit.
   The measured incremental time includes parent selection (`git rev-list`), `git diff-tree`, copying the
   parent's file rows, parsing the 100 new blobs and marking the snapshot available. The script reports
   `changed_count` and `parsed_count` so incrementality is visible.
4. Pick up to 500 random symbol names from the index and run each query type `--queries` times after one warm-up
   call: `fts`, `findSymbol`, `exact`, `hybrid`, and `buildContextPack` (default 8,000-token budget, which also
   persists the pack). Latency is wall-clock per call inside the warmed process.

Index timings are single runs; re-run to gauge variance. Search percentiles are over the stated sample count.

## Results (measured 2026-11-02)

Machine: AMD Ryzen 7 5800X (8 cores / 16 threads), 31.2 GB RAM, Kingston SNV3S1000G NVMe (btrfs on LUKS),
Linux 7.2.11-arch1-1, Bun 1.4.4, Git 2.56.0, SQLite durability `FULL` (WAL).

### Synthetic, 50,000 files, workdir on NVMe

| Measurement | Result |
|---|---|
| Cold index (50,101 files, 50,052 blobs parsed) | 25.5 s |
| Incremental, 100 changed files (100 blobs parsed) | 2.75 s |
| `fts` p50 / p95 | 7.3 ms / 8.0 ms |
| `findSymbol` p50 / p95 | 1.1 ms / 1.2 ms |
| `exact` p50 / p95 | 7.2 ms / 7.9 ms |
| `hybrid` p50 / p95 | 10.9 ms / 12.0 ms |
| context pack p50 / p95 (n=50) | 16.3 ms / 17.6 ms |
| Database size | 143 MB |

Same run with the workdir on `tmpfs` (`/tmp`): cold 14.6 s, incremental 0.88 s, `hybrid` p95 20.5 ms,
context pack p95 19.5 ms. The difference in indexing time is fsync cost under `FULL` durability.

### Synthetic, 5,000 files, workdir on tmpfs

Cold 1.49 s (5,052 blobs), incremental 121 ms (100 parsed), `fts` p95 2.3 ms, `hybrid` p95 4.0 ms, context pack
p95 4.3 ms, database 15 MB.

### Real repositories, workdir on tmpfs (cold + latency only)

| Repository | Indexed files | Cold | `hybrid` p95 | context pack p95 |
|---|---|---|---|---|
| local application repository A | 2,214 | 3.85 s | 6.0 ms | 17.5 ms |
| local application repository B | 2,057 | 6.49 s | 5.4 ms | 8.5 ms |

Real files are larger than the synthetic ones, so per-file cold cost is higher.

## Against the PRD targets

Indexed search p95 is well under 1 s and the 100-file incremental update is well under 30 s on this machine for
50,000 tracked files. These numbers come from synthetic content and the machine above; they are evidence for
this configuration, not a guarantee for other repositories or hardware.

## Remediation baseline and experiment decisions (2026-11-05)

The same Ryzen 5800X / 31.2 GB / Linux 7.2.11 / Bun 1.4.4 machine, local btrfs NVMe under
`~/.cache/crew-remediation-bench`, SQLite WAL with `FULL` durability. Independent temporary databases and
repositories were used; this was a shared development machine with concurrent tests and builds. Five cold
samples establish an observed range and median, not a reliable tail estimate or a controlled percentage win.
No real provider or hosted CI workload was substituted with these measurements.

| Workload | Cold samples | Cold median / range | 100-file incremental median / range |
|---|---:|---|---|
| Synthetic, 50,101 tracked files | 5 | 27.973 s / 26.346–31.876 s | 2.898 s / 2.755–3.082 s |
| Crewyard, 397–402 tracked files | 5 | 1.295 s / 0.890–1.489 s | Not measured |
| Larger local real repository, 2,083 tracked files | 5 | 9.471 s / 8.581–11.296 s | Not measured |

Crewyard's source changed during these samples; they are workload observations, not paired comparisons of an
optimization. Each cold run used 200 queries per search mode and 50 context packs. Synthetic hybrid search
p95 ranged 13.8–17.9 ms; the largest context-pack p95 was 41.2 ms. The existing indexed-search p95 <1 s and
100-file incremental <30 s budgets pass for this documented workload. One additional 50k run with schema-v5
writer guards under concurrent load measured 32.867 s cold, 3.741 s incremental and 28.1 ms hybrid p95; it is
one observation, not a before/after distribution.

Thirty warm exact-snapshot index calls measured 1.0–10.2 ms on the synthetic workload. Thirty independent
full worktree materializations measured 1.575–2.179 s (median 1.672 s) for 50k files and 25.5–28.7 ms
(median 26.8 ms) for Crewyard. Worktree metadata alone was 1.8–2.9 ms and 2.0–2.9 ms respectively.
Only disposable, attempt-owned worktrees were created and removed; bootstrap/provider execution was excluded.

Reproduce cold/query runs with the commands above. `--warm-runs 30` adds warm index samples and a scratch
SQL membership-copy comparison; `--warm-concurrency 6` runs each warm batch at the configured default global
capacity, alternating available base/head snapshots. The schema permits larger explicit operator limits, but
the experiment does not increase any operator limit. JSON now records exact source commit/tree identities and
warm concurrency. Cold means a fresh index/database, not a flushed operating-system page cache.

A separate 30-batch run at concurrency six alternated two indexed commits (180 exact-SHA requests):
0.1–0.7 ms per cached batch, 3.766 s for its 100-file update and 13.6 ms hybrid p95 (200 queries).
These calls omit Git ref resolution; they are a different route from the earlier warm ref-based samples,
so their difference is not an optimization comparison.

### Decisions on repeated work

| Finding | Evidence and decision |
|---|---|
| Repeated Git fetches | Adopt exact-OID cross-process coalescing. Ten processes transfer one commit once; moving branch refs and `FETCH_HEAD` remain unchanged. Shared failure, remote identity change and killed-owner cases are real-process tests. Bytes transferred are unknown, so no byte-saving claim. Fresh remote branch observations remain separate. |
| Sparse checkout | Reject for this rollout. Full materialization is small relative to indexing, and there is no operator-verified dependency/config/test closure. Scope hints cannot establish equivalence. Full checkout remains the explicit supported behavior; no sparse prototype or silent fallback ships. |
| Bootstrap/artifact reuse | Reject for this rollout. Crewyard has no configured bootstrap commands in this assessed checkout and no verified immutable artifact manifest. The general bootstrap path runs arbitrary approved commands and may inject referenced secrets; writable `node_modules` cannot be a shared artifact boundary. No measured bootstrap bottleneck or safe general reuse boundary was established. |
| Snapshot overlays | Reject. Incremental parsing changes 100 blobs, but membership still loads/writes all 50,101 rows: load 51–57 ms, row writes 0.893–1.078 s before commit/fsync in the five samples. Thirty scratch `INSERT ... SELECT` copies measured 76.6–113.3 ms; this is a lower bound without full production semantics. Both current budgets pass, so retain flat snapshots and remove no correctness checks. |
| Adaptive scheduler tuning | Reject. Retain fixed defaults: six execution slots, eight open PRs, 120-minute queue-age backpressure and one recovery reservation. A deterministic 100-task burst replay exercised 30 seeds × four provider capacities (including offline) × four backlog levels × two queue ages: 960 decisions per policy. Default, stricter and looser policies each had zero hard-limit violations and admitted recovery whenever capacity existed. Stricter/looser thresholds changed implementation admissions (210/630 versus default 420), but this decision replay supplies no measured production completion-latency improvement. |

The scheduler replay shadows pure decisions only; it launches no providers or remote mutations. Slow-worker
acceptance is tested causally with process barriers: an unrelated ready project and same-branch synchronization
must progress while validation is held, and integration leadership must renew. There is no invented throughput
or percentage target. SQLite acquisition has a 1,000 ms total default wait budget (plus one ≤50 ms native poll),
bounded retries and observed contention counters; a real locked-database process test measured about 1.05 s.
