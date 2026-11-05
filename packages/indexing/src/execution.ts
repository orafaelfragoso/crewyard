import type { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import {
  CrewError,
  fingerprint,
  isProcessAlive,
  matchesRecordedProcess,
  newId,
  nowIso,
  processIdentity,
  toCrewError,
} from '@crewyard/core';
import {
  abandonExecutionClaim,
  acquireExecutionClaim,
  all,
  assertExecutionClaim,
  bindExecutionProcess,
  type CrewContext,
  type ExecutionClaim,
  executionContext,
  getExecutionClaim,
  releaseExecutionClaim,
  renewExecutionClaim,
} from '@crewyard/storage';
import { snapshotById } from './store.ts';
import type { Snapshot } from './types.ts';

const CLAIM_SECONDS = 120;
const WAIT_MS = 120_000;

export function indexBuildScope(repositoryId: string, commitSha: string): string {
  return `index:build:${repositoryId}:${commitSha}`;
}

function transact<T>(ctx: CrewContext, fn: (db: Database) => T): T {
  return ctx.store.db.inTransaction ? fn(ctx.store.db) : ctx.store.immediate(fn);
}

export function recoverIndexClaims(ctx: CrewContext): void {
  const at = nowIso(ctx.clock);
  const scopes = all<{ scope: string }>(
    ctx.store.db,
    "SELECT scope FROM execution_claims WHERE released_at IS NULL AND expires_at <= ? AND (scope LIKE 'index:build:%' OR scope LIKE 'index:read:%')",
    at,
  );
  for (const { scope } of scopes) {
    const claim = getExecutionClaim(ctx.store.db, scope)!;
    const process = claim.process;
    if (!process || process.host !== hostname()) continue;
    if (isProcessAlive(process.pid) && matchesRecordedProcess(process.pid, process.startIdentity) !== false) continue;
    transact(ctx, (db) => {
      const current = getExecutionClaim(db, scope);
      if (current?.attemptId === claim.attemptId && current.releasedAt === null && current.expiresAt <= at)
        abandonExecutionClaim(db, current, at);
    });
  }
}

export function hasIndexReaders(db: Database, snapshotId: string | null): boolean {
  const prefix = snapshotId === null ? 'index:read:' : `index:read:${snapshotId}:`;
  return (
    db.query('SELECT 1 FROM execution_claims WHERE released_at IS NULL AND instr(scope, ?) = 1 LIMIT 1').get(prefix) !==
    null
  );
}

export function hasIndexBuilds(db: Database): boolean {
  return (
    db
      .query("SELECT 1 FROM execution_claims WHERE released_at IS NULL AND scope LIKE 'index:build:%' LIMIT 1")
      .get() !== null
  );
}

export function snapshotInUse(
  db: Database,
  snapshot: { id: string; repositoryId: string; commitSha: string },
): boolean {
  const build = getExecutionClaim(db, indexBuildScope(snapshot.repositoryId, snapshot.commitSha));
  return (build !== null && build.releasedAt === null) || hasIndexReaders(db, snapshot.id);
}

interface IndexOwnership {
  ctx: CrewContext;
  claim: ExecutionClaim;
  release(): void;
}

function owned(ctx: CrewContext, claim: ExecutionClaim): IndexOwnership {
  const cancelled = new AbortController();
  const signal = ctx.execution ? AbortSignal.any([ctx.execution.signal, cancelled.signal]) : cancelled.signal;
  const guarded = executionContext(ctx, {
    claim,
    directory: ctx.execution?.directory ?? ctx.dirs.artifacts,
    signal,
    onSpawn: ctx.execution?.onSpawn ?? (() => {}),
  });
  const timer = setInterval(
    () => {
      try {
        transact(ctx, (db) => renewExecutionClaim(db, claim, CLAIM_SECONDS, nowIso(ctx.clock)));
      } catch (error) {
        cancelled.abort(error);
      }
    },
    (CLAIM_SECONDS * 1000) / 3,
  );
  let released = false;
  return {
    ctx: guarded,
    claim,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        transact(ctx, (db) => {
          const at = nowIso(ctx.clock);
          const current = getExecutionClaim(db, claim.scope);
          if (current?.attemptId !== claim.attemptId || current.releasedAt !== null) return;
          if (current.expiresAt <= at) abandonExecutionClaim(db, claim, at);
          else releaseExecutionClaim(db, claim, at);
        });
      } catch (error) {
        if (!(error instanceof CrewError && error.code === 'STALE_LEASE')) throw error;
        ctx.logger.warn('Index claim retained after parent ownership ended', {
          attemptId: claim.attemptId,
          error: toCrewError(error).message,
        });
      }
    },
  };
}

function acquire(
  ctx: CrewContext,
  scope: string,
  inputIdentity: string,
  check: (db: Database) => void,
): IndexOwnership | null {
  const identity = processIdentity(process.pid);
  if (!identity) throw new CrewError('UNAVAILABLE', 'Cannot verify index process identity');
  const attemptId = newId('lease');
  const claim = transact(ctx, (db) => {
    check(db);
    const current = getExecutionClaim(db, scope);
    if (current?.releasedAt === null) return null;
    const at = nowIso(ctx.clock);
    const acquired = acquireExecutionClaim(
      db,
      {
        scope,
        attemptId,
        ownerId: ctx.execution?.claim.ownerId ?? attemptId,
        inputIdentity,
        ttlSeconds: CLAIM_SECONDS,
      },
      at,
    );
    if (!acquired) return null;
    bindExecutionProcess(db, acquired, { host: hostname(), pid: process.pid, startIdentity: identity }, at);
    return acquired;
  });
  return claim ? owned(ctx, claim) : null;
}

export async function acquireIndexBuild(
  ctx: CrewContext,
  repositoryId: string,
  commitSha: string,
  revision: string,
): Promise<IndexOwnership> {
  const deadline = performance.now() + WAIT_MS;
  while (performance.now() < deadline) {
    ctx.execution?.signal.throwIfAborted();
    recoverIndexClaims(ctx);
    const claim = acquire(ctx, indexBuildScope(repositoryId, commitSha), revision, () => {});
    if (claim) return claim;
    await Bun.sleep(25);
  }
  throw new CrewError('BUSY', 'Index build is still owned by another process');
}

export function acquireSnapshotReader(
  ctx: CrewContext,
  snapshot: Snapshot,
): { release(): void; assertCurrent(db: Database): void } {
  const reader = acquire(
    ctx,
    `index:read:${snapshot.id}:${newId('lease')}`,
    fingerprint({ snapshotId: snapshot.id, revision: snapshot.revision }),
    (db) => {
      const current = snapshotById(db, snapshot.id);
      if (
        current?.status !== 'available' ||
        current.commitSha !== snapshot.commitSha ||
        current.revision !== snapshot.revision
      )
        throw new CrewError('INDEX_STALE', 'Snapshot changed before the reader acquired it');
    },
  )!;
  return { release: reader.release, assertCurrent: (db) => assertExecutionClaim(db, reader.claim, nowIso(ctx.clock)) };
}
