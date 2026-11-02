import { nowIso, RailError } from '@agent-rail/core';
import type { RailContext } from '@agent-rail/storage';
import { type IndexOptions, indexRepository, resolveCommit } from './build.ts';
import {
  DEFAULT_INDEX_CONFIG,
  latestAvailable,
  loadRepository,
  type RepositoryRecord,
  snapshotByCommit,
} from './store.ts';
import type { IndexConfig, IndexStatus, ResultEnvelope, Snapshot, SnapshotSelector } from './types.ts';

export interface SnapshotRequest extends SnapshotSelector {
  onDemand?: boolean;
  config?: IndexConfig;
}

export interface ResolvedSnapshot {
  repo: RepositoryRecord;
  snapshot: Snapshot;
  envelope: ResultEnvelope;
}

export function indexCommand(repositoryId: string, sha: string, force = false): string {
  return `rail index update --repo ${repositoryId} --ref ${sha}${force ? ' --force' : ''}`;
}

function envelopeFor(ctx: RailContext, snapshot: Snapshot): ResultEnvelope {
  return {
    repositoryId: snapshot.repositoryId,
    commitSha: snapshot.commitSha,
    snapshotId: snapshot.id,
    retrievedAt: nowIso(ctx.clock),
    indexStatus: 'fresh',
  };
}

export async function requireSnapshot(ctx: RailContext, request: SnapshotRequest): Promise<ResolvedSnapshot> {
  const { repo, commitSha } = await resolveCommit(ctx, request);
  let snapshot = snapshotByCommit(ctx.store.db, repo.id, commitSha);
  if (snapshot?.status !== 'available' && request.onDemand) {
    const options: IndexOptions = {
      repositoryId: repo.id,
      sha: commitSha,
      config: request.config ?? DEFAULT_INDEX_CONFIG,
    };
    if (request.ref !== undefined) options.ref = request.ref;
    snapshot = (await indexRepository(ctx, options)).snapshot;
  }
  if (snapshot?.status !== 'available') {
    const status: IndexStatus = snapshot ? snapshot.status : 'missing';
    throw new RailError('INDEX_STALE', `No available index for ${repo.id}@${commitSha} (status: ${status})`, {
      details: { repositoryId: repo.id, commitSha, status },
      suggestion: indexCommand(repo.id, commitSha, status === 'stale'),
    });
  }
  return { repo, snapshot, envelope: envelopeFor(ctx, snapshot) };
}

export interface IndexStatusReport {
  repositoryId: string;
  ref: string;
  headSha: string;
  status: IndexStatus;
  snapshot: Snapshot | null;
  latestAvailable: Snapshot | null;
  suggestion: string | null;
  checkedAt: string;
}

export async function indexStatus(ctx: RailContext, selector: SnapshotSelector): Promise<IndexStatusReport> {
  const repo = loadRepository(ctx.store.db, selector.repositoryId);
  const ref = selector.sha ?? selector.ref ?? (selector.worktreePath ? 'HEAD' : repo.defaultBase);
  const { commitSha } = await resolveCommit(ctx, selector);
  const snapshot = snapshotByCommit(ctx.store.db, repo.id, commitSha);
  const latest = latestAvailable(ctx.store.db, repo.id);
  let status: IndexStatus;
  if (snapshot?.status === 'available') status = 'fresh';
  else if (snapshot?.status === 'building' || snapshot?.status === 'failed') status = snapshot.status;
  else status = latest ? 'stale' : 'missing';
  return {
    repositoryId: repo.id,
    ref,
    headSha: commitSha,
    status,
    snapshot,
    latestAvailable: latest,
    suggestion: status === 'fresh' || status === 'building' ? null : indexCommand(repo.id, commitSha),
    checkedAt: nowIso(ctx.clock),
  };
}
