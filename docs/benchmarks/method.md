# Index and retrieval benchmark method

Script: `scripts/bench-index.ts`. It measures what PRD §2.3 asks for: cold indexing time, a 100-file
incremental update, and indexed search latency (p50/p95). LLM, embedding and GitHub latency are excluded; no
embedding provider is configured.

```sh
bun scripts/bench-index.ts --files 50000 --queries 200 --workdir ~/.cache/rail-bench   # synthetic repository
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
