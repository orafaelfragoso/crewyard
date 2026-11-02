import { RailError } from '@agent-rail/core';
import {
  collectPatch,
  type RequestReviewResult,
  type ReviewDeps,
  type ReviewType,
  requestReview,
} from '@agent-rail/reviews';
import { listOutbox, type RailContext } from '@agent-rail/storage';
import { fetchIntegrationRefs } from './candidates.ts';
import { configFor, repositoryFor } from './env.ts';
import { GITHUB_OUTBOX_KINDS } from './outbox.ts';
import { type QueueStatus, queueStatusFor } from './queue.ts';
import { candidateById, listCandidatesForQueue, queuesForRepository, requirePullRequest } from './records.ts';
import { type RemoteFreshness, readFreshness } from './sync-state.ts';
import type { IntegrationCandidate, IntegrationEnv } from './types.ts';

export interface IntegrationStatus {
  repositoryId: string;
  remote: RemoteFreshness;
  queues: QueueStatus[];
  pendingRemoteOperations: {
    operationId: string;
    kind: string;
    status: string;
    attempts: number;
    lastError: string | null;
  }[];
}

export function integrationStatus(ctx: RailContext, repositoryId: string, env: IntegrationEnv = {}): IntegrationStatus {
  const repository = repositoryFor(ctx, repositoryId);
  const config = configFor(ctx, env, repository.projectId);
  const pending = GITHUB_OUTBOX_KINDS.flatMap((kind) => listOutbox(ctx.store, { kind }))
    .filter((op) => (op.intent as Record<string, unknown>).repositoryId === repositoryId)
    .map((op) => ({
      operationId: op.operationId,
      kind: op.kind,
      status: op.status,
      attempts: op.attempts,
      lastError: op.lastError,
    }));
  return {
    repositoryId,
    remote: readFreshness(ctx.store.db, repositoryId),
    queues: queuesForRepository(ctx.store.db, repositoryId).map((q) =>
      queueStatusFor(ctx.store.db, q, ctx.clock.now(), config.scheduler.max_queue_age_minutes),
    ),
    pendingRemoteOperations: pending,
  };
}

export function getCandidate(ctx: RailContext, candidateId: string): IntegrationCandidate {
  const candidate = candidateById(ctx.store.db, candidateId);
  if (!candidate) throw new RailError('NOT_FOUND', `Candidate not found: ${candidateId}`);
  return candidate;
}

export function listCandidates(ctx: RailContext, queueId: string, limit = 20): IntegrationCandidate[] {
  return listCandidatesForQueue(ctx.store.db, queueId, limit);
}

export interface PullRequestReviewInput {
  prId: string;
  types?: ReviewType[];
  force?: boolean;
}

export async function requestPullRequestReview(
  ctx: RailContext,
  input: PullRequestReviewInput,
  deps: Omit<ReviewDeps, 'config'> & { env?: IntegrationEnv },
): Promise<RequestReviewResult> {
  const pr = requirePullRequest(ctx.store.db, input.prId);
  const repository = repositoryFor(ctx, pr.repositoryId);
  const config = configFor(ctx, deps.env ?? {}, repository.projectId);
  const base = pr.governance?.integrationBase ?? pr.baseRef;
  const baseSha = await fetchIntegrationRefs(repository.canonicalPath, base, [pr]);
  const patch = await collectPatch(repository.canonicalPath, baseSha, pr.headSha);
  return requestReview(
    ctx,
    {
      repositoryId: pr.repositoryId,
      prId: pr.id,
      taskId: pr.taskId,
      commitSha: pr.headSha,
      baseSha,
      patch,
      ...(input.types ? { types: input.types } : {}),
      ...(input.force ? { force: true } : {}),
    },
    { ...deps, config },
  );
}
