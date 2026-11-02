import { type Actor, nowIso, SYSTEM_ACTOR } from '@agent-rail/core';
import { all, type RailContext, recordTransition } from '@agent-rail/storage';
import { readChunks } from './content.ts';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import { listTree, readBlobs } from './git-source.ts';
import { forgetSnapshotModels } from './graph.ts';
import { prepareText } from './process.ts';
import { createPathRules } from './rules.ts';
import { DEFAULT_INDEX_CONFIG, indexRevision } from './store.ts';

export type VerifyProblemKind =
  | 'missing_file'
  | 'unexpected_file'
  | 'blob_mismatch'
  | 'missing_blob'
  | 'size_mismatch'
  | 'content_mismatch';

export interface VerifyProblem {
  kind: VerifyProblemKind;
  path: string | null;
  blobSha: string | null;
  detail: string;
}

export interface VerifyInput extends SnapshotRequest {
  sample?: number;
  markStale?: boolean;
  actor?: Actor;
}

export interface VerifyResult {
  ok: boolean;
  repositoryId: string;
  snapshotId: string;
  commitSha: string;
  checkedFiles: number;
  checkedBlobs: number;
  problemCount: number;
  problems: VerifyProblem[];
  notes: string[];
  markedStale: boolean;
  verifiedAt: string;
}

const MAX_REPORTED = 200;

export async function verifyIndex(ctx: RailContext, input: VerifyInput): Promise<VerifyResult> {
  const { repo, snapshot } = await requireSnapshot(ctx, { ...input, onDemand: false });
  const config = input.config ?? DEFAULT_INDEX_CONFIG;
  const notes: string[] = [];
  if (snapshot.revision !== indexRevision(config)) {
    notes.push(
      'Snapshot was built with different index rules; file-set differences may reflect configuration, not tampering.',
    );
  }
  const problems: VerifyProblem[] = [];
  let problemCount = 0;
  const report = (p: VerifyProblem) => {
    problemCount++;
    if (problems.length < MAX_REPORTED) problems.push(p);
  };

  const rules = createPathRules(config);
  const tree = new Map(
    (await listTree(repo.canonicalPath, snapshot.commitSha))
      .filter((e) => rules.decide(e.path).include)
      .map((e) => [e.path, e]),
  );
  const stored = all<{
    path: string;
    blob_sha: string;
    size: number;
    parse_status: string | null;
    blob_size: number | null;
  }>(
    ctx.store.db,
    `SELECT f.path, f.blob_sha, f.size, b.parse_status, b.size AS blob_size
     FROM files f LEFT JOIN blobs b ON b.sha = f.blob_sha WHERE f.snapshot_id = ?`,
    snapshot.id,
  );
  const storedPaths = new Set<string>();
  const contentBlobs = new Map<string, string>();
  for (const row of stored) {
    storedPaths.add(row.path);
    const entry = tree.get(row.path);
    if (!entry) {
      report({
        kind: 'unexpected_file',
        path: row.path,
        blobSha: row.blob_sha,
        detail: 'indexed path is not in the commit tree',
      });
      continue;
    }
    if (entry.blobSha !== row.blob_sha) {
      report({
        kind: 'blob_mismatch',
        path: row.path,
        blobSha: row.blob_sha,
        detail: `commit has blob ${entry.blobSha}`,
      });
      continue;
    }
    if (row.parse_status === null) {
      report({ kind: 'missing_blob', path: row.path, blobSha: row.blob_sha, detail: 'blob row is missing' });
      continue;
    }
    if (row.blob_size !== entry.size || row.size !== entry.size) {
      report({
        kind: 'size_mismatch',
        path: row.path,
        blobSha: row.blob_sha,
        detail: `git size ${entry.size}, indexed ${row.blob_size}`,
      });
    }
    if (row.parse_status !== 'skipped' && !contentBlobs.has(row.blob_sha)) contentBlobs.set(row.blob_sha, row.path);
  }
  for (const path of tree.keys()) {
    if (!storedPaths.has(path))
      report({ kind: 'missing_file', path, blobSha: tree.get(path)!.blobSha, detail: 'tracked path is not indexed' });
  }

  let shas = [...contentBlobs.keys()];
  if (input.sample !== undefined && input.sample < shas.length) {
    for (let i = shas.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shas[i], shas[j]] = [shas[j]!, shas[i]!];
    }
    shas = shas.slice(0, input.sample);
    notes.push(`Content verified for a random sample of ${input.sample} blobs.`);
  }
  for await (const blob of readBlobs(repo.canonicalPath, shas, Number.MAX_SAFE_INTEGER)) {
    const prepared = blob.bytes ? prepareText(blob.bytes) : null;
    const expected = prepared?.chunks ?? [];
    const actual = readChunks(ctx.store.db, blob.sha);
    const same =
      expected.length === actual.length &&
      expected.every((c, i) => {
        const a = actual[i]!;
        return a.startLine === c.startLine && a.endLine === c.endLine && a.content === c.content;
      });
    if (!same) {
      report({
        kind: 'content_mismatch',
        path: contentBlobs.get(blob.sha) ?? null,
        blobSha: blob.sha,
        detail: 'stored text differs from the redacted Git blob',
      });
    }
  }

  const markStale = (input.markStale ?? false) && problemCount > 0;
  const at = nowIso(ctx.clock);
  if (markStale) {
    ctx.store.immediate((db) => {
      db.query(`UPDATE repository_snapshots SET status = 'stale', error = ? WHERE id = ?`).run(
        `verify found ${problemCount} problems`,
        snapshot.id,
      );
      recordTransition(
        db,
        {
          type: 'index.snapshot_stale',
          actor: input.actor ?? SYSTEM_ACTOR,
          projectId: repo.projectId,
          payload: { repositoryId: repo.id, snapshotId: snapshot.id, problems: problemCount },
        },
        { action: 'index.verify', input: { snapshotId: snapshot.id }, decision: 'stale' },
        at,
      );
    });
    forgetSnapshotModels([snapshot.id]);
  }
  return {
    ok: problemCount === 0,
    repositoryId: repo.id,
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    checkedFiles: stored.length,
    checkedBlobs: shas.length,
    problemCount,
    problems,
    notes,
    markedStale: markStale,
    verifiedAt: at,
  };
}
