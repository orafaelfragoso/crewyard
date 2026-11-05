import { hostname } from 'node:os';
import {
  type Actor,
  CrewError,
  fingerprint,
  git,
  gitText,
  isProcessAlive,
  matchesRecordedProcess,
  newId,
  nowIso,
  processIdentity,
} from '@crewyard/core';
import {
  abandonExecutionClaim,
  acquireExecutionClaim,
  assertExecutionClaim,
  bindExecutionProcess,
  type CrewContext,
  getExecutionClaim,
  one,
  recordTransition,
  releaseExecutionClaim,
} from '@crewyard/storage';
import { getRepository } from './projects.ts';

export interface FetchCommitInput {
  repositoryId: string;
  remote: string;
  commitSha: string;
  actor: Actor;
}
export interface FetchCommitResult {
  commitSha: string;
  reused: boolean;
  joined: boolean;
}

async function commitExists(path: string, sha: string): Promise<boolean> {
  const result = await git(path, ['cat-file', '-t', sha], { allowFailure: true });
  if (result.exitCode !== 0) return false;
  if (result.stdout.trim() !== 'commit') throw new CrewError('INVALID_INPUT', 'Wanted Git object is not a commit');
  return true;
}

/** Fetches immutable objects; callers must separately observe current remote refs. */
export async function fetchCommit(ctx: CrewContext, input: FetchCommitInput): Promise<FetchCommitResult> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commitSha))
    throw new CrewError('INVALID_INPUT', 'Fetch requires a full lowercase commit OID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.remote))
    throw new CrewError('INVALID_INPUT', 'Fetch requires a configured remote name');
  const repository = getRepository(ctx, input.repositoryId);
  const remoteIdentity = fingerprint(await gitText(repository.canonicalPath, ['remote', 'get-url', input.remote]));
  const identity = fingerprint({ repositoryId: repository.id, remoteIdentity, commitSha: input.commitSha });
  const scope = `fetch:${identity}`;
  const started = performance.now();
  const deadline = started + 180_000;
  let joinedAttempt: string | null = null;
  for (;;) {
    ctx.execution?.signal.throwIfAborted();
    if (joinedAttempt) {
      const outcome = one<{ outcome: string }>(
        ctx.store.db,
        `SELECT json_extract(payload, '$.outcome') AS outcome FROM events WHERE type = 'repository.fetch_finished' AND correlation_id = ? ORDER BY seq DESC LIMIT 1`,
        joinedAttempt,
      );
      if (outcome?.outcome === 'failed')
        throw new CrewError('EXTERNAL_FAILURE', 'The shared commit fetch failed; retry after checking the remote', {
          retryable: true,
        });
      if (!outcome) {
        const owner = getExecutionClaim(ctx.store.db, scope);
        if (
          owner?.attemptId === joinedAttempt &&
          owner.releasedAt === null &&
          owner.process?.host === hostname() &&
          (!isProcessAlive(owner.process.pid) ||
            matchesRecordedProcess(owner.process.pid, owner.process.startIdentity) === false)
        ) {
          ctx.store.immediate((db) => {
            const current = getExecutionClaim(db, scope);
            if (current?.attemptId !== owner.attemptId || current.releasedAt !== null) return;
            const at = nowIso(ctx.clock);
            if (current.expiresAt <= at) abandonExecutionClaim(db, current, at);
            else releaseExecutionClaim(db, current, at);
            recordTransition(
              db,
              {
                type: 'repository.fetch_interrupted',
                actor: input.actor,
                projectId: repository.projectId,
                correlationId: owner.attemptId,
                payload: { repositoryId: repository.id, commitSha: input.commitSha, reason: 'verified_owner_gone' },
              },
              { action: 'repository.fetch_recover', input: { attemptId: owner.attemptId }, decision: 'retry' },
              at,
            );
          });
          continue;
        }
        if (owner?.attemptId === joinedAttempt && owner.releasedAt === null && owner.expiresAt > nowIso(ctx.clock)) {
          if (performance.now() >= deadline)
            throw new CrewError('BUSY', 'Timed out waiting for the shared commit fetch', { retryable: true });
          await Bun.sleep(50);
          continue;
        }
      }
    }
    if (await commitExists(repository.canonicalPath, input.commitSha)) {
      const observedRemote = fingerprint(await gitText(repository.canonicalPath, ['remote', 'get-url', input.remote]));
      if (observedRemote !== remoteIdentity)
        throw new CrewError('CONFLICT', 'Remote identity changed during commit fetch');
      return { commitSha: input.commitSha, reused: true, joined: joinedAttempt !== null };
    }
    const claim = ctx.store.immediate((db) =>
      acquireExecutionClaim(
        db,
        {
          scope,
          attemptId: newId('op'),
          ownerId: `${hostname()}:${process.pid}`,
          inputIdentity: identity,
          ttlSeconds: 240,
        },
        nowIso(ctx.clock),
      ),
    );
    if (!claim) {
      const owner = getExecutionClaim(ctx.store.db, scope);
      if (owner && owner.attemptId !== joinedAttempt) {
        joinedAttempt = owner.attemptId;
        ctx.store.immediate((db) =>
          recordTransition(
            db,
            {
              type: 'repository.fetch_joined',
              actor: input.actor,
              projectId: repository.projectId,
              correlationId: owner.attemptId,
              payload: { repositoryId: repository.id, commitSha: input.commitSha },
            },
            { action: 'repository.fetch_join', input: { attemptId: joinedAttempt }, decision: 'joined' },
            nowIso(ctx.clock),
          ),
        );
      }
      if (performance.now() >= deadline)
        throw new CrewError('BUSY', 'Timed out waiting for the shared commit fetch', { retryable: true });
      await Bun.sleep(50);
      continue;
    }
    const birth = processIdentity(process.pid);
    if (birth)
      ctx.store.immediate((db) =>
        bindExecutionProcess(
          db,
          claim,
          { host: hostname(), pid: process.pid, startIdentity: birth },
          nowIso(ctx.clock),
        ),
      );
    let outcome: 'completed' | 'failed' = 'failed';
    try {
      if (await commitExists(repository.canonicalPath, input.commitSha)) {
        outcome = 'completed';
        return { commitSha: input.commitSha, reused: true, joined: joinedAttempt !== null };
      }
      // An OID ref is immutable across generations, so an expired writer cannot move a successor's input.
      await git(
        repository.canonicalPath,
        [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--quiet',
          input.remote,
          `${input.commitSha}:refs/crew/objects/${input.commitSha}`,
        ],
        {
          timeoutMs: 120_000,
          ...(ctx.execution ? { signal: ctx.execution.signal, onSpawn: ctx.execution.onSpawn } : {}),
        },
      );
      if (!(await commitExists(repository.canonicalPath, input.commitSha)))
        throw new CrewError('EXTERNAL_FAILURE', 'Fetch did not supply the wanted commit');
      const observedRemote = fingerprint(await gitText(repository.canonicalPath, ['remote', 'get-url', input.remote]));
      if (observedRemote !== remoteIdentity)
        throw new CrewError('CONFLICT', 'Remote identity changed during commit fetch');
      outcome = 'completed';
      return { commitSha: input.commitSha, reused: false, joined: joinedAttempt !== null };
    } finally {
      ctx.store.immediate((db) => {
        const at = nowIso(ctx.clock);
        assertExecutionClaim(db, claim, at);
        recordTransition(
          db,
          {
            type: 'repository.fetch_finished',
            actor: input.actor,
            projectId: repository.projectId,
            correlationId: claim.attemptId,
            payload: {
              repositoryId: repository.id,
              remoteIdentity,
              commitSha: input.commitSha,
              outcome,
              durationMs: performance.now() - started,
              joined: joinedAttempt !== null,
              transferredBytes: null,
            },
          },
          { action: 'repository.fetch', input: { identity }, decision: outcome },
          at,
        );
        releaseExecutionClaim(db, claim, at);
      });
    }
  }
}
