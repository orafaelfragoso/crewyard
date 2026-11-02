import type { Database } from 'bun:sqlite';
import { railConfigSchema } from '@agent-rail/config';
import { fingerprint, RailError } from '@agent-rail/core';
import { one } from '@agent-rail/storage';
import { EXTRACTOR_REVISION } from './grammars.ts';
import type { IndexConfig, Snapshot, SnapshotStatus } from './types.ts';

export interface RepositoryRecord {
  id: string;
  projectId: string;
  canonicalPath: string;
  defaultBase: string;
}

export function loadRepository(db: Database, repositoryId: string): RepositoryRecord {
  const row = one<{ id: string; project_id: string; canonical_path: string; default_base: string }>(
    db,
    'SELECT id, project_id, canonical_path, default_base FROM repositories WHERE id = ?',
    repositoryId,
  );
  if (!row) {
    throw new RailError('NOT_FOUND', `Repository not found: ${repositoryId}`, {
      suggestion: 'Run `rail project list` to see registered repositories.',
    });
  }
  return { id: row.id, projectId: row.project_id, canonicalPath: row.canonical_path, defaultBase: row.default_base };
}

export interface SnapshotRow {
  id: string;
  repository_id: string;
  commit_sha: string;
  tree_sha: string | null;
  ref: string | null;
  parent_snapshot_id: string | null;
  status: SnapshotStatus;
  file_count: number;
  changed_count: number;
  parsed_count: number;
  symbol_graph_revision: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export function mapSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    commitSha: row.commit_sha,
    treeSha: row.tree_sha,
    ref: row.ref,
    parentSnapshotId: row.parent_snapshot_id,
    status: row.status,
    fileCount: row.file_count,
    changedCount: row.changed_count,
    parsedCount: row.parsed_count,
    revision: row.symbol_graph_revision,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

export function snapshotByCommit(db: Database, repositoryId: string, commitSha: string): Snapshot | null {
  const row = one<SnapshotRow>(
    db,
    'SELECT * FROM repository_snapshots WHERE repository_id = ? AND commit_sha = ?',
    repositoryId,
    commitSha,
  );
  return row ? mapSnapshot(row) : null;
}

export function snapshotById(db: Database, id: string): Snapshot | null {
  const row = one<SnapshotRow>(db, 'SELECT * FROM repository_snapshots WHERE id = ?', id);
  return row ? mapSnapshot(row) : null;
}

export function latestAvailable(db: Database, repositoryId: string): Snapshot | null {
  const row = one<SnapshotRow>(
    db,
    `SELECT * FROM repository_snapshots WHERE repository_id = ? AND status = 'available'
     ORDER BY completed_at DESC, id DESC LIMIT 1`,
    repositoryId,
  );
  return row ? mapSnapshot(row) : null;
}

export const DEFAULT_INDEX_CONFIG: IndexConfig = railConfigSchema.shape.index.parse(undefined);

export function indexRevision(config: IndexConfig): string {
  const rules = fingerprint({
    extractor: EXTRACTOR_REVISION,
    languages: [...config.languages].sort(),
    exclude: config.exclude,
    maxFileBytes: config.max_file_bytes,
  });
  return `r${EXTRACTOR_REVISION}:${rules.slice(0, 16)}`;
}

export const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}
