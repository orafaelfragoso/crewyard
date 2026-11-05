# Indexing and context retrieval

Packages: `@crewyard/indexing` (snapshots, extraction, search, graph, embeddings, verify, GC) and
`@crewyard/context` (context packs, impact analysis, interface fingerprints). Every service takes a
`CrewContext` first and returns JSON-serialisable values, so the CLI (`crew index …`, `crew context …`) and MCP
tools (`crew_search_context`, `crew_get_symbol`, `crew_analyze_impact`) call them directly.

## Snapshots

A snapshot is the index of one commit SHA of a registered repository (`repository_snapshots`, unique per
`(repository_id, commit_sha)`). Indexing never checks anything out:

1. Resolve the selector (`sha`, `ref`, or the HEAD of a `worktreePath` that shares the object store) to a commit.
2. Acquire a renewable, process-bound build claim for the repository and exact commit, then claim the snapshot
   row as `building` in a short transaction. Every `indexRepository` caller uses this ownership path. A competing
   build waits within a bounded budget; expiry alone does not permit reuse while the recorded process remains
   live or unverifiable. Application workers also pin the exact commit and index configuration before admission,
   so moving the selected branch cannot change an already admitted request.
3. Choose the nearest `available` parent snapshot built with the same rules revision: the first hit walking
   `git rev-list` (up to 1,000 ancestors), otherwise the most recent snapshot whose commit exists locally.
4. With a parent, load its complete `files` membership and apply `git diff-tree -r -z -M --raw` (adds, modifications, deletes,
   renames, with new blob SHAs). Without one, list the tree with `git ls-tree -r -z --long`.
5. Blobs already present in `blobs` with the current parser identity are reused. Only new blobs are streamed
   through one `git cat-file --batch` process, parsed outside any transaction, then written in batches of 250
   blobs per `BEGIN IMMEDIATE` transaction (blob row, symbols, edges and full-text chunks of a blob always commit
   together, with the `files` rows that reference them).
   Incremental parsing reuses unchanged blobs, but membership loading and writing remain O(N) per snapshot. `IndexStats` separately reports membership load time, row-write time (excluding transaction commit/fsync), and rows written; it does not claim O(changed files) total indexing.
6. A final transaction checks the file count, marks the snapshot `available`, records `changed_count` /
   `parsed_count`, updates `repositories.index_coverage`, and writes an `index.snapshot_available` event and
   audit row. Failures mark the snapshot `failed` with an event.

`symbol_graph_revision` stores the rules revision (`r<extractor>:<hash of languages, exclude, max_file_bytes>`).
A parent is only reused when the revision matches, so changing exclusion rules triggers a full listing (blobs
are still reused). `blobs.parser` stores the grammar identity (`tree-sitter-typescript@0.23.2#1`, `text#1`,
`skip#1`); bumping `EXTRACTOR_REVISION` re-parses blobs on next use. `force: true` re-parses every blob of the
snapshot, which is the repair path after `verifyIndex` marks a snapshot `stale`. Extraction rows are shared by
blob SHA across repositories. Replacing them refuses with `BUSY` while another build or a reader of affected
snapshots may depend on them. Once safe, replacement marks affected historical snapshots stale and removes
their derived context artifacts before changing extraction. Querying those snapshots requires rebuilding them;
they cannot remain falsely fresh under another configuration.

## Inclusion rules

Applied per path before any content is read:

| Rule | Effect |
|---|---|
| Secret file names (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `.npmrc`, `.netrc`, `*.tfstate`, …) | Excluded entirely; no `files` row. |
| `index.exclude` globs (`Bun.Glob`) | Excluded entirely. |
| Generated paths (lockfiles, `dist/`, `vendor/`, `*.min.js`, `*.map`, `_pb2.py`, …) | `files` row kept (tree, package-manager detection), content not indexed. |
| Size over `index.max_file_bytes`, NUL bytes in the first 8 KB, `@generated`/`DO NOT EDIT` headers, minified shape | Blob `parse_status = 'skipped'`. |
| Everything else | Redacted, chunked into FTS, parsed when the language is enabled. |

Only tracked files are visible (`ls-tree`), so `.gitignore` is honoured implicitly. Symlinks and submodules are
skipped.

## Secrets

Content is redacted before anything is stored or parsed: private-key blocks are replaced line by line (line
numbers stay stable), then `redactSecrets` from `@crewyard/core` runs over the text. Tree-sitter parses the
redacted text, so signatures cannot carry raw secrets. Blobs with redactions get `parse_status = 'redacted'` and
a `redactions` count. Excerpts returned to agents come from the stored (redacted) chunks, never from Git.

## Storage layout

- `fts_entries` (FTS5) holds non-overlapping chunks of at most ~40 lines / 4 KB per blob, with
  `blob_sha`, `start_line`, `end_line`. FTS5 cannot index `blob_sha`, so chunk rowids are content-addressed:
  `rowid = slot(blob_sha) * 4096 + chunk_index`, where the slot is the first 40 bits of the SHA with linear
  probing (up to 4 slots) on collision. Reading or deleting a blob's chunks is a rowid range lookup.
- `symbols` and `symbol_edges` are keyed by blob, so identical content is parsed once across commits, branches
  and worktrees.
- `files` is per snapshot (`path`, `blob_sha`, `language`, `kind`, `package_root`).
- `embeddings` is keyed by `(blob_sha, chunk start_line, provider:model)`.

## Extraction

Tree-sitter (`web-tree-sitter` 0.27 with the grammar `.wasm` files imported as `type: 'file'` so
`bun build --compile` embeds them; grammar ABI is checked at load) covers TypeScript/TSX, JavaScript, Python
and Rust:

- Symbols: functions, classes, methods (with container), interfaces, type aliases, enums, namespaces, top-level
  constants/variables (Python module assignments, `__all__` aware), Rust structs/enums/traits/impl methods/
  consts/macros/modules. `exported` follows `export`, `pub`, or Python naming/`__all__`.
- Edges (`resolution = 'syntax'`): `import` (module specifier + imported name), `export`, `call` (callee name,
  enclosing symbol) and `reference` (type identifiers, `new X`, base classes, impl traits).
- Markdown links become `reference` edges with `resolution = 'file'`.
- Other languages are text-only (FTS, path search, file-level references).

### Import resolution is computed per snapshot

Whether `./math.js` resolves to `src/math.ts` depends on the importing file's path and on the snapshot's file
set, while edges are stored per blob. Resolution therefore runs at query time against the snapshot and is cached
in-process (LRU of 4 snapshot models; snapshots are immutable once available). `symbol_edges.resolved_path` is
left `NULL` for this reason. The resolver handles relative TS/JS specifiers (including `.js`→`.ts`, index
files), workspace packages by `package.json` name/`exports`, Python relative and absolute modules
(repository root, `src/`, pyproject roots), and Rust `mod`, `crate::`, `self::`, `super::` and workspace crate
names. Path aliases (`tsconfig` `paths`), dynamic imports with computed specifiers and macro-generated modules
are not resolved. Outputs carry the note that the graph is syntax-level, not a complete semantic call graph.

## Freshness and provenance

`requireSnapshot` is the single entry point used by every query. If the requested commit has no `available`
snapshot it either indexes on demand (`onDemand: true`) or throws `INDEX_STALE` with the exact recovery command
(`crew index update --repo <id> --ref <sha>`, plus `--force` for a `stale` snapshot). It never falls back to
another commit. Every result carries `{repositoryId, commitSha, snapshotId, retrievedAt, indexStatus}` and every
hit/excerpt carries a full `Provenance` with path, line range and blob SHA. `indexStatus()` reports
`fresh | stale | building | failed | missing` for a ref (default: the repository's base branch).

Queries pin the exact available snapshot with a durable reader claim. The pin spans awaited embedding calls,
excerpt materialization and context-artifact insertion. Garbage collection rechecks ownership inside its write
transaction; it cannot delete a snapshot or replace shared extraction while that reader is active. Expired pins
are reclaimed only after the recorded process is proven gone or replaced, rather than from elapsed time alone.

## Search

`search()` modes: `fts` (bm25), `exact` (FTS phrase prefilter, then literal line match), `regex` (bounded scan of
the snapshot's stored chunks: 64 MB / 5 s), `path` (glob or substring), `symbol`, and `hybrid`. Hybrid ranking is
a weighted sum of normalised signals: scope hints 1.5, symbol name 1.2, FTS 1.0, cosine similarity 1.0 (only when
a provider and stored vectors exist), path 0.5, plus 1-hop import-graph neighbours of the top files at 0.35. All
modes accept `paths`/`excludePaths` globs, `kinds` and `languages` filters.

## Embeddings

`EmbeddingProvider` is a small interface (`embed(texts) → Float32Array[]`). `OllamaEmbeddingProvider` posts to
`<endpoint>/api/embed` (default `http://127.0.0.1:11434`) and refuses non-local endpoints unless
`index.embedding.consent_external` is true (also enforced by config validation). `createEmbeddingProvider`
returns `null` unless `index.embedding.provider: ollama` and a model are configured. `embedSnapshot` embeds
missing chunks in batches (network outside transactions) and records an `embedding_index` artifact.

## Context packs

`buildContextPack` runs a hybrid search (query + task scope paths/symbols), merges overlapping ranges per file,
caps each excerpt at `maxExcerptLines` (default 60), and fills the token budget (default
`index.max_context_tokens`, 8,000). Tokens are estimated as `ceil(chars / 4) + 16` per excerpt (`chars/4+16`), a
deliberately conservative approximation that does not depend on a model tokenizer. An excerpt that does not fit
is cut at a line boundary and the remainder starts the next page; warnings report truncation and remaining
candidates. The ranked candidate list (not the text) is persisted in `context_artifacts` (`kind = 'context_pack'`,
7-day expiry), and `fetchContextPackPage({ cursor })` re-materialises later pages from the same snapshot.

## Impact analysis

`analyzeImpact` takes changed paths and/or symbols at a commit and returns, each with a confidence tier:

- changed files and touched packages/top-level directories (`exact`);
- dependents via the reverse import graph up to `depth` (`structural`), plus files that only mention a changed
  symbol by name (`heuristic`);
- related tests: changed tests (`exact`), importing tests (`structural`), naming conventions such as
  `foo.test.ts`, `test_foo.py`, `foo_test.rs` (`heuristic`);
- active `task_scope_reservations` whose path scope contains a changed file (`exact`) or a dependent
  (`structural`); resource scopes (`name:value`) never match paths, mirroring `@crewyard/tasks`;
- open pull requests whose `changed_files` (array of paths or GitHub file objects) include changed files
  (`exact`), dependents (`structural`) or files in the same package (`heuristic`).

Reports include an explicit disclaimer that heuristic predictions never prove the absence of conflicts and are
stored as `impact_report` artifacts. `interfaceFingerprint` hashes the exported symbol names, kinds, containers
and signatures of the given files (line numbers excluded), or the blob SHA for files without a parser, so
reviews can detect relevant interface/schema changes (AT-08).

## Verification and garbage collection

`verifyIndex` re-lists the commit tree, re-reads blobs from Git, re-applies redaction and chunking, and compares
against the stored rows (`missing_file`, `unexpected_file`, `blob_mismatch`, `missing_blob`, `size_mismatch`,
`content_mismatch`). With `markStale: true` a failing snapshot is marked `stale` so queries refuse it until it is
rebuilt with `force`.

`collectGarbage` defaults to a dry run. It keeps the newest `retainLatest` available snapshots per repository,
any `retainShas`, running builds and active readers; deletes other snapshots, expired or orphaned artifacts, and
blobs no longer referenced by any snapshot (with their chunks, symbols, edges and embeddings). Blob collection
is skipped while a build or reader is active. Each deletion rechecks current ownership, so a preview does not
authorize removing resources acquired by another process afterward.
