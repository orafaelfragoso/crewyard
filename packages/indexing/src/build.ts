import type { Database } from 'bun:sqlite';
import {
  type Actor,
  CrewError,
  type GitOptions,
  newId,
  nowIso,
  revParse,
  SYSTEM_ACTOR,
  toCrewError,
  withProcessLifecycle,
} from '@crewyard/core';
import { all, type CrewContext, one, recordTransition } from '@crewyard/storage';
import { acquireIndexBuild, acquireSnapshotReader, hasIndexReaders } from './execution.ts';
import { ancestors, diffTrees, hasCommit, listTree, readBlobs, treeSha } from './git-source.ts';
import { forgetSnapshotModels } from './graph.ts';
import { type BlobPlan, type BlobRecord, expectedParser, processBlob, SKIP_PARSER, skippedRecord } from './process.ts';
import {
  basenameOf,
  classifyFile,
  createPathRules,
  detectLanguage,
  dirnameOf,
  PACKAGE_MANIFESTS,
  type PathRules,
  parserLanguageFor,
} from './rules.ts';
import {
  chunked,
  DEFAULT_INDEX_CONFIG,
  FULL_SHA,
  indexRevision,
  loadRepository,
  type RepositoryRecord,
  snapshotByCommit,
  snapshotById,
} from './store.ts';
import type { FileKind, IndexConfig, Snapshot, SnapshotSelector } from './types.ts';
import { type FileRow, writeBlobs, writeFiles } from './writer.ts';

const ANCESTOR_SEARCH_DEPTH = 1_000;

export interface IndexOptions extends SnapshotSelector {
  config?: IndexConfig;
  force?: boolean;
  actor?: Actor;
  batchSize?: number;
}

export interface IndexStats {
  mode: 'cold' | 'incremental' | 'noop';
  trackedFiles: number;
  indexedFiles: number;
  excludedFiles: number;
  secretFiles: number;
  changedFiles: number;
  parsedBlobs: number;
  reusedBlobs: number;
  redactedBlobs: number;
  durationMs: number;
  membershipLoadMs: number;
  membershipWriteMs: number;
  membershipRowsWritten: number;
}

export interface IndexResult {
  snapshot: Snapshot;
  stats: IndexStats;
}

export interface ResolvedCommit {
  repo: RepositoryRecord;
  commitSha: string;
  ref: string | null;
}

export async function resolveCommit(
  ctx: CrewContext,
  selector: SnapshotSelector,
  options?: GitOptions,
): Promise<ResolvedCommit> {
  const repo = loadRepository(ctx.store.db, selector.repositoryId);
  const sha = selector.sha?.toLowerCase();
  if (sha && FULL_SHA.test(sha) && snapshotByCommit(ctx.store.db, repo.id, sha)) {
    return { repo, commitSha: sha, ref: selector.ref ?? null };
  }
  const cwd = selector.worktreePath ?? repo.canonicalPath;
  const target = selector.sha ?? selector.ref ?? (selector.worktreePath ? 'HEAD' : repo.defaultBase);
  const commitSha = await revParse(cwd, target, options);
  if (!commitSha) {
    throw new CrewError('NOT_FOUND', `Cannot resolve ${target} to a commit in ${cwd}`, {
      details: { repositoryId: repo.id, ref: target },
      suggestion: 'Fetch the branch or pass a full commit SHA that exists locally.',
    });
  }
  if (selector.worktreePath && !(await hasCommit(repo.canonicalPath, commitSha))) {
    throw new CrewError(
      'INVALID_INPUT',
      `Worktree ${selector.worktreePath} does not share objects with ${repo.canonicalPath}`,
      {
        suggestion: 'Create the worktree with `git worktree add` from the registered repository.',
      },
    );
  }
  return { repo, commitSha, ref: selector.sha ? (selector.ref ?? null) : target };
}

interface PlannedFile extends FileRow {
  contentIndexed: boolean;
  parserLanguage: ReturnType<typeof parserLanguageFor>;
}

interface RuleCounters {
  excluded: number;
  secret: number;
}

function planFile(
  path: string,
  blobSha: string,
  size: number,
  rules: PathRules,
  config: IndexConfig,
  counters: RuleCounters,
): PlannedFile | null {
  const decision = rules.decide(path);
  if (!decision.include) {
    if (decision.reason === 'secret') counters.secret++;
    else counters.excluded++;
    return null;
  }
  const language = detectLanguage(path);
  return {
    path,
    blobSha,
    size,
    language,
    kind: classifyFile(path, language),
    packageRoot: null,
    contentIndexed: decision.contentIndexed,
    parserLanguage: parserLanguageFor(path, language, config),
  };
}

export function assignPackageRoots(files: Iterable<{ path: string; packageRoot: string | null }>): void {
  const list = [...files];
  const roots = new Set<string>();
  for (const f of list) if (PACKAGE_MANIFESTS.has(basenameOf(f.path))) roots.add(dirnameOf(f.path) || '.');
  for (const f of list) {
    let dir = dirnameOf(f.path);
    let root: string | null = null;
    for (;;) {
      const key = dir || '.';
      if (roots.has(key)) {
        root = key;
        break;
      }
      if (dir === '') break;
      dir = dirnameOf(dir);
    }
    f.packageRoot = root;
  }
}

interface ParentChoice {
  snapshot: Snapshot;
}

async function chooseParent(
  ctx: CrewContext,
  repo: RepositoryRecord,
  commitSha: string,
  revision: string,
): Promise<ParentChoice | null> {
  const candidates = all<{ id: string; commit_sha: string }>(
    ctx.store.db,
    `SELECT id, commit_sha FROM repository_snapshots
     WHERE repository_id = ? AND status = 'available' AND symbol_graph_revision = ? AND commit_sha != ?
     ORDER BY completed_at DESC, id DESC`,
    repo.id,
    revision,
    commitSha,
  );
  if (candidates.length === 0) return null;
  const byCommit = new Map(candidates.map((c) => [c.commit_sha, c.id]));
  for (const ancestor of await ancestors(repo.canonicalPath, commitSha, ANCESTOR_SEARCH_DEPTH)) {
    const id = byCommit.get(ancestor);
    const snapshot = id ? snapshotById(ctx.store.db, id) : null;
    if (snapshot) return { snapshot };
  }
  for (const candidate of candidates) {
    if (await hasCommit(repo.canonicalPath, candidate.commit_sha)) {
      const snapshot = snapshotById(ctx.store.db, candidate.id);
      if (snapshot) return { snapshot };
    }
  }
  return null;
}

function claimSnapshot(
  ctx: CrewContext,
  resolved: ResolvedCommit,
  tree: string,
  revision: string,
  parentId: string | null,
  force: boolean,
  actor: Actor,
): Snapshot | 'noop' {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const existing = snapshotByCommit(db, resolved.repo.id, resolved.commitSha);
    if (existing?.status === 'available' && existing.revision === revision && !force) return 'noop';
    if (existing && hasIndexReaders(db, existing.id)) {
      throw new CrewError('BUSY', 'Snapshot has active readers; retry the rebuild after they finish');
    }
    if (existing) {
      db.query('UPDATE repository_snapshots SET parent_snapshot_id = NULL WHERE parent_snapshot_id = ?').run(
        existing.id,
      );
      db.query('DELETE FROM repository_snapshots WHERE id = ?').run(existing.id);
    }
    const id = newId('snap');
    db.query(
      `INSERT INTO repository_snapshots (id, repository_id, commit_sha, tree_sha, ref, parent_snapshot_id, status, symbol_graph_revision, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?)`,
    ).run(id, resolved.repo.id, resolved.commitSha, tree, resolved.ref, parentId, revision, at);
    recordTransition(
      db,
      {
        type: 'index.snapshot_started',
        actor,
        projectId: resolved.repo.projectId,
        payload: {
          snapshotId: id,
          repositoryId: resolved.repo.id,
          commitSha: resolved.commitSha,
          attemptId: ctx.execution!.claim.attemptId,
        },
      },
      {
        action: 'index.build',
        input: { repositoryId: resolved.repo.id, commitSha: resolved.commitSha, revision, force },
        decision: 'building',
      },
      at,
    );
    return snapshotById(db, id)!;
  });
}

function existingParsers(db: Database, shas: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const batch of chunked(shas, 500)) {
    const rows = all<{ sha: string; parser: string | null }>(
      db,
      `SELECT sha, parser FROM blobs WHERE sha IN (${batch.map(() => '?').join(',')})`,
      ...batch,
    );
    for (const row of rows) out.set(row.sha, row.parser);
  }
  return out;
}

export async function indexRepository(ctx: CrewContext, options: IndexOptions): Promise<IndexResult> {
  const started = performance.now();
  const resolved = await resolveCommit(ctx, options);
  const ownership = await acquireIndexBuild(
    ctx,
    resolved.repo.id,
    resolved.commitSha,
    indexRevision(options.config ?? DEFAULT_INDEX_CONFIG),
  );
  try {
    return await withProcessLifecycle(ownership.ctx.execution!, () =>
      buildOwnedRepository(ownership.ctx, options, resolved, started),
    );
  } finally {
    ownership.release();
  }
}

async function buildOwnedRepository(
  ctx: CrewContext,
  options: IndexOptions,
  resolved: ResolvedCommit,
  started: number,
): Promise<IndexResult> {
  const config = options.config ?? DEFAULT_INDEX_CONFIG;
  if (!config.enabled) {
    throw new CrewError('POLICY_DENIED', 'Indexing is disabled by configuration (index.enabled: false)', {
      suggestion: 'Set index.enabled: true in .crewyard/config.yaml.',
    });
  }
  const { repo, commitSha } = resolved;
  const revision = indexRevision(config);
  const actor = options.actor ?? SYSTEM_ACTOR;
  const force = options.force ?? false;
  const existing = snapshotByCommit(ctx.store.db, repo.id, commitSha);
  if (existing?.status === 'available' && existing.revision === revision && !force) {
    return { snapshot: existing, stats: noopStats(existing, started) };
  }

  const tree = await treeSha(repo.canonicalPath, commitSha);
  const parent = config.incremental && !force ? await chooseParent(ctx, repo, commitSha, revision) : null;
  const parentReader = parent ? acquireSnapshotReader(ctx, parent.snapshot) : null;
  let claimed: Snapshot | 'noop';
  try {
    claimed = claimSnapshot(ctx, resolved, tree, revision, parent?.snapshot.id ?? null, force, actor);
  } catch (error) {
    parentReader?.release();
    throw error;
  }
  if (claimed === 'noop') {
    parentReader?.release();
    const snapshot = snapshotByCommit(ctx.store.db, repo.id, commitSha)!;
    return { snapshot, stats: noopStats(snapshot, started) };
  }

  try {
    const rules = createPathRules(config);
    const counters: RuleCounters = { excluded: 0, secret: 0 };
    const files = new Map<string, PlannedFile>();
    let trackedFiles: number;
    let changedFiles: number;
    let membershipLoadMs = 0;
    let membershipWriteMs = 0;
    let membershipRowsWritten = 0;

    if (parent) {
      const loadStarted = performance.now();
      const parentRows = all<{ path: string; blob_sha: string; language: string | null; size: number; kind: FileKind }>(
        ctx.store.db,
        'SELECT path, blob_sha, language, size, kind FROM files WHERE snapshot_id = ?',
        parent.snapshot.id,
      );
      for (const row of parentRows) {
        const decision = rules.decide(row.path);
        files.set(row.path, {
          path: row.path,
          blobSha: row.blob_sha,
          size: row.size,
          language: row.language,
          kind: row.kind,
          packageRoot: null,
          contentIndexed: decision.include && decision.contentIndexed,
          parserLanguage: parserLanguageFor(row.path, row.language, config),
        });
      }
      membershipLoadMs = performance.now() - loadStarted;
      const changes = await diffTrees(repo.canonicalPath, parent.snapshot.commitSha, commitSha);
      changedFiles = changes.length;
      const sizes = new Map<string, number>();
      const needSize = changes.filter((c) => c.newBlobSha !== null).map((c) => c.path);
      if (needSize.length > 0) {
        for (const entry of await listTree(repo.canonicalPath, commitSha, needSize)) sizes.set(entry.path, entry.size);
      }
      for (const change of changes) {
        if (change.oldPath) files.delete(change.oldPath);
        files.delete(change.path);
        if (change.status === 'D' || change.newBlobSha === null) continue;
        if (change.newMode !== '100644' && change.newMode !== '100755') continue;
        const planned = planFile(change.path, change.newBlobSha, sizes.get(change.path) ?? 0, rules, config, counters);
        if (planned) files.set(change.path, planned);
      }
      trackedFiles = files.size + counters.excluded + counters.secret;
    } else {
      const entries = await listTree(repo.canonicalPath, commitSha);
      trackedFiles = entries.length;
      changedFiles = entries.length;
      for (const entry of entries) {
        const planned = planFile(entry.path, entry.blobSha, entry.size, rules, config, counters);
        if (planned) files.set(entry.path, planned);
      }
    }
    assignPackageRoots(files.values());
    parentReader?.release();

    const byBlob = new Map<string, PlannedFile[]>();
    for (const f of files.values()) {
      const list = byBlob.get(f.blobSha);
      if (list) list.push(f);
      else byBlob.set(f.blobSha, [f]);
    }
    const known = existingParsers(ctx.store.db, [...byBlob.keys()]);
    const ready: FileRow[] = [];
    const plans: BlobPlan[] = [];
    const skipped: BlobRecord[] = [];
    const replace = new Set<string>();
    for (const [sha, list] of byBlob) {
      const first = list.find((f) => f.contentIndexed) ?? list[0]!;
      const plan: BlobPlan = {
        sha,
        path: first.path,
        language: first.language,
        parserLanguage: first.parserLanguage,
        size: first.size,
        contentIndexed: first.contentIndexed,
      };
      const current = known.get(sha);
      const wanted = !plan.contentIndexed || plan.size > config.max_file_bytes ? SKIP_PARSER : expectedParser(plan);
      const reusable = current !== undefined && !force && current === wanted;
      if (reusable) {
        ready.push(...list);
        continue;
      }
      if (current !== undefined) replace.add(sha);
      if (!plan.contentIndexed || plan.size > config.max_file_bytes) skipped.push(skippedRecord(plan, plan.size));
      else plans.push(plan);
    }

    const batchSize = options.batchSize ?? 250;
    const at = nowIso(ctx.clock);
    const writeMembership = (db: Database, rows: readonly FileRow[]) => {
      const writeStarted = performance.now();
      writeFiles(db, claimed.id, rows);
      membershipWriteMs += performance.now() - writeStarted;
      membershipRowsWritten += rows.length;
    };
    for (const batch of chunked(ready, 2_000)) ctx.store.immediate((db) => writeMembership(db, batch));
    let parsedBlobs = 0;
    let redactedBlobs = 0;
    const flush = (records: BlobRecord[]) => {
      if (records.length === 0) return;
      const rows = records.flatMap((r) => byBlob.get(r.sha) ?? []);
      parsedBlobs += ctx.store.immediate((db) => {
        const replaced = records.filter((record) => replace.has(record.sha)).map((record) => record.sha);
        if (replaced.length > 0) {
          if (
            db
              .query(
                "SELECT 1 FROM execution_claims WHERE released_at IS NULL AND scope LIKE 'index:build:%' AND scope != ? LIMIT 1",
              )
              .get(ctx.execution!.claim.scope)
          )
            throw new CrewError('BUSY', 'Another index build may use this shared extraction; retry after it finishes');
          const affected = all<{ id: string }>(
            db,
            `SELECT DISTINCT s.id FROM repository_snapshots s JOIN files f ON f.snapshot_id = s.id WHERE f.blob_sha IN (${replaced.map(() => '?').join(',')}) AND s.id != ? AND s.status IN ('available', 'building')`,
            ...replaced,
            claimed.id,
          );
          if (affected.some((snapshot) => hasIndexReaders(db, snapshot.id)))
            throw new CrewError('BUSY', 'Shared index extraction has active readers; retry after they finish');
          for (const snapshot of affected) {
            db.query(
              "UPDATE repository_snapshots SET status = 'stale', error = 'Shared extraction changed under another index configuration' WHERE id = ?",
            ).run(snapshot.id);
            db.query('DELETE FROM context_artifacts WHERE snapshot_id = ?').run(snapshot.id);
          }
          forgetSnapshotModels(affected.map((snapshot) => snapshot.id));
          if (affected.length)
            recordTransition(
              db,
              {
                type: 'index.snapshots_invalidated',
                actor,
                projectId: repo.projectId,
                payload: { snapshotIds: affected.map((snapshot) => snapshot.id), reason: 'shared_extraction_replaced' },
              },
              { action: 'index.replace_extraction', input: { blobShas: replaced }, decision: 'invalidated' },
              at,
            );
        }
        const written = writeBlobs(db, records, replace, at);
        writeMembership(db, rows);
        return written;
      });
      redactedBlobs += records.filter((r) => r.parseStatus === 'redacted').length;
    };
    for (const batch of chunked(skipped, batchSize)) flush(batch);
    const planBySha = new Map(plans.map((p) => [p.sha, p]));
    let pending: BlobRecord[] = [];
    for await (const blob of readBlobs(repo.canonicalPath, [...planBySha.keys()], config.max_file_bytes)) {
      pending.push(await processBlob(planBySha.get(blob.sha)!, blob.bytes, blob.size));
      if (pending.length >= batchSize) {
        flush(pending);
        pending = [];
      }
    }
    flush(pending);

    const snapshot = finalizeSnapshot(ctx, {
      snapshotId: claimed.id,
      repo,
      expectedFiles: files.size,
      changedFiles,
      parsedBlobs,
      actor,
      tree,
      coverage: coverageOf(files.values(), counters),
    });
    return {
      snapshot,
      stats: {
        mode: parent ? 'incremental' : 'cold',
        trackedFiles,
        indexedFiles: files.size,
        excludedFiles: counters.excluded,
        secretFiles: counters.secret,
        changedFiles,
        parsedBlobs,
        reusedBlobs: byBlob.size - parsedBlobs,
        redactedBlobs,
        durationMs: Math.round(performance.now() - started),
        membershipLoadMs,
        membershipWriteMs,
        membershipRowsWritten,
      },
    };
  } catch (error) {
    failSnapshot(ctx, claimed.id, repo, error, actor);
    throw error;
  } finally {
    parentReader?.release();
  }
}

function coverageOf(files: Iterable<PlannedFile>, counters: RuleCounters): Record<string, unknown> {
  const languages: Record<string, number> = {};
  let contentIndexed = 0;
  for (const f of files) {
    if (f.language) languages[f.language] = (languages[f.language] ?? 0) + 1;
    if (f.contentIndexed) contentIndexed++;
  }
  return { languages, contentIndexed, excluded: counters.excluded, secretSkipped: counters.secret };
}

interface FinalizeInput {
  snapshotId: string;
  repo: RepositoryRecord;
  expectedFiles: number;
  changedFiles: number;
  parsedBlobs: number;
  actor: Actor;
  tree: string;
  coverage: Record<string, unknown>;
}

function finalizeSnapshot(ctx: CrewContext, input: FinalizeInput): Snapshot {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const count = one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM files WHERE snapshot_id = ?', input.snapshotId)!.n;
    if (count !== input.expectedFiles) {
      throw new CrewError(
        'INTERNAL',
        `Snapshot ${input.snapshotId} has ${count} files, expected ${input.expectedFiles}`,
      );
    }
    db.query(
      `UPDATE repository_snapshots SET status = 'available', file_count = ?, changed_count = ?, parsed_count = ?, completed_at = ?, error = NULL
       WHERE id = ? AND status = 'building'`,
    ).run(count, input.changedFiles, input.parsedBlobs, at, input.snapshotId);
    const snapshot = snapshotById(db, input.snapshotId)!;
    db.query('UPDATE repositories SET index_coverage = ?, content_fingerprint = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({
        snapshotId: snapshot.id,
        commitSha: snapshot.commitSha,
        ref: snapshot.ref,
        files: count,
        ...input.coverage,
      }),
      input.tree,
      at,
      input.repo.id,
    );
    recordTransition(
      db,
      {
        type: 'index.snapshot_available',
        actor: input.actor,
        projectId: input.repo.projectId,
        payload: {
          repositoryId: input.repo.id,
          snapshotId: snapshot.id,
          commitSha: snapshot.commitSha,
          files: count,
          changed: input.changedFiles,
          parsed: input.parsedBlobs,
        },
      },
      {
        action: 'index.build',
        input: { repositoryId: input.repo.id, commitSha: snapshot.commitSha },
        decision: 'available',
      },
      at,
    );
    return snapshot;
  });
}

function failSnapshot(
  ctx: CrewContext,
  snapshotId: string,
  repo: RepositoryRecord,
  error: unknown,
  actor: Actor,
): void {
  const message = toCrewError(error).message.slice(0, 1_000);
  const at = nowIso(ctx.clock);
  try {
    ctx.store.immediate((db) => {
      db.query(
        `UPDATE repository_snapshots SET status = 'failed', error = ?, completed_at = ? WHERE id = ? AND status = 'building'`,
      ).run(message, at, snapshotId);
      recordTransition(
        db,
        {
          type: 'index.snapshot_failed',
          actor,
          projectId: repo.projectId,
          payload: { repositoryId: repo.id, snapshotId, error: message },
        },
        { action: 'index.build', input: { repositoryId: repo.id, snapshotId }, decision: 'failed' },
        at,
      );
    });
  } catch (inner) {
    ctx.logger.error('failed to record index failure', { snapshotId, error: toCrewError(inner).message });
  }
}

function noopStats(snapshot: Snapshot, started: number): IndexStats {
  return {
    mode: 'noop',
    trackedFiles: snapshot.fileCount,
    indexedFiles: snapshot.fileCount,
    excludedFiles: 0,
    secretFiles: 0,
    changedFiles: 0,
    parsedBlobs: 0,
    reusedBlobs: 0,
    redactedBlobs: 0,
    durationMs: Math.round(performance.now() - started),
    membershipLoadMs: 0,
    membershipWriteMs: 0,
    membershipRowsWritten: 0,
  };
}
