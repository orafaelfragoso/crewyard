import type { Database } from 'bun:sqlite';
import { type Actor, nowIso, SYSTEM_ACTOR } from '@crewyard/core';
import { all, type CrewContext, one, recordTransition } from '@crewyard/storage';
import { deleteChunks } from './content.ts';
import { forgetSnapshotModels } from './graph.ts';
import { chunked } from './store.ts';

const STALE_BUILD_MS = 15 * 60 * 1000;

export interface GarbageCollectionInput {
  repositoryId?: string;
  retainLatest?: number;
  retainShas?: string[];
  dryRun?: boolean;
  actor?: Actor;
}

export interface GarbageCollectionResult {
  dryRun: boolean;
  snapshots: { id: string; repositoryId: string; commitSha: string; ref: string | null; status: string }[];
  blobCount: number;
  artifactCount: number;
  notes: string[];
}

interface SnapRow {
  id: string;
  repository_id: string;
  commit_sha: string;
  ref: string | null;
  status: string;
  started_at: string;
}

function activeBuild(db: Database, now: number): boolean {
  return all<{ started_at: string }>(db, "SELECT started_at FROM repository_snapshots WHERE status = 'building'").some(
    (r) => now - Date.parse(r.started_at) < STALE_BUILD_MS,
  );
}

function orphanBlobs(db: Database, excluded: readonly string[], limit: number): string[] {
  const placeholders = excluded.map(() => '?').join(',');
  return all<{ sha: string }>(
    db,
    `SELECT b.sha FROM blobs b WHERE NOT EXISTS (
       SELECT 1 FROM files f WHERE f.blob_sha = b.sha ${excluded.length ? `AND f.snapshot_id NOT IN (${placeholders})` : ''}
     ) LIMIT ?`,
    ...excluded,
    limit,
  ).map((r) => r.sha);
}

export function collectGarbage(ctx: CrewContext, input: GarbageCollectionInput = {}): GarbageCollectionResult {
  const db = ctx.store.db;
  const dryRun = input.dryRun ?? true;
  const retainLatest = Math.max(input.retainLatest ?? 3, 1);
  const retainShas = new Set(input.retainShas ?? []);
  const now = ctx.clock.now().getTime();
  const at = nowIso(ctx.clock);
  const notes: string[] = [];

  const rows = input.repositoryId
    ? all<SnapRow>(
        db,
        'SELECT id, repository_id, commit_sha, ref, status, started_at FROM repository_snapshots WHERE repository_id = ? ORDER BY completed_at DESC, id DESC',
        input.repositoryId,
      )
    : all<SnapRow>(
        db,
        'SELECT id, repository_id, commit_sha, ref, status, started_at FROM repository_snapshots ORDER BY completed_at DESC, id DESC',
      );
  const keptPerRepo = new Map<string, number>();
  const doomed: SnapRow[] = [];
  for (const row of rows) {
    if (row.status === 'building' && now - Date.parse(row.started_at) < STALE_BUILD_MS) continue;
    if (retainShas.has(row.commit_sha)) continue;
    if (row.status === 'available') {
      const kept = keptPerRepo.get(row.repository_id) ?? 0;
      if (kept < retainLatest) {
        keptPerRepo.set(row.repository_id, kept + 1);
        continue;
      }
    }
    doomed.push(row);
  }
  const doomedIds = doomed.map((d) => d.id);
  const building = activeBuild(db, now);
  if (building) notes.push('An index build is running; blob collection was skipped to avoid racing it.');

  const artifactSql = `SELECT id FROM context_artifacts WHERE (expires_at IS NOT NULL AND expires_at <= ?)
     OR (snapshot_id IS NULL AND kind != 'embedding_index')
     ${doomedIds.length ? `OR snapshot_id IN (${doomedIds.map(() => '?').join(',')})` : ''}`;
  const artifacts = all<{ id: string }>(db, artifactSql, at, ...doomedIds).map((r) => r.id);
  const blobPreview = building ? [] : orphanBlobs(db, doomedIds, 1_000_000);

  if (dryRun) {
    return {
      dryRun,
      snapshots: doomed.map((d) => ({
        id: d.id,
        repositoryId: d.repository_id,
        commitSha: d.commit_sha,
        ref: d.ref,
        status: d.status,
      })),
      blobCount: blobPreview.length,
      artifactCount: artifacts.length,
      notes,
    };
  }

  for (const batch of chunked(artifacts, 500)) {
    ctx.store.immediate((tx) =>
      tx.query(`DELETE FROM context_artifacts WHERE id IN (${batch.map(() => '?').join(',')})`).run(...batch),
    );
  }
  for (const snap of doomed) {
    ctx.store.immediate((tx) => {
      tx.query('UPDATE repository_snapshots SET parent_snapshot_id = NULL WHERE parent_snapshot_id = ?').run(snap.id);
      tx.query('DELETE FROM context_artifacts WHERE snapshot_id = ?').run(snap.id);
      tx.query('DELETE FROM repository_snapshots WHERE id = ?').run(snap.id);
    });
  }
  forgetSnapshotModels(doomedIds);

  let blobCount = 0;
  if (!building) {
    for (;;) {
      const removed = ctx.store.immediate((tx) => {
        if (activeBuild(tx, now)) return -1;
        const batch = orphanBlobs(tx, [], 500);
        for (const sha of batch) {
          deleteChunks(tx, sha);
          tx.query('DELETE FROM blobs WHERE sha = ?').run(sha);
        }
        return batch.length;
      });
      if (removed <= 0) break;
      blobCount += removed;
    }
  }

  ctx.store.immediate((tx) => {
    const projectId = input.repositoryId
      ? (one<{ project_id: string }>(tx, 'SELECT project_id FROM repositories WHERE id = ?', input.repositoryId)
          ?.project_id ?? null)
      : null;
    recordTransition(
      tx,
      {
        type: 'index.garbage_collected',
        actor: input.actor ?? SYSTEM_ACTOR,
        projectId,
        payload: { snapshots: doomedIds.length, blobs: blobCount, artifacts: artifacts.length },
      },
      { action: 'index.gc', input: { repositoryId: input.repositoryId ?? null, retainLatest }, decision: 'applied' },
      at,
    );
  });

  return {
    dryRun,
    snapshots: doomed.map((d) => ({
      id: d.id,
      repositoryId: d.repository_id,
      commitSha: d.commit_sha,
      ref: d.ref,
      status: d.status,
    })),
    blobCount,
    artifactCount: artifacts.length,
    notes,
  };
}
