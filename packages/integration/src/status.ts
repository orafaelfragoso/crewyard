import { CrewError } from '@crewyard/core';
import {
  collectPatch,
  type RequestReviewResult,
  type ReviewDeps,
  type ReviewType,
  requestReview,
} from '@crewyard/reviews';
import { type CrewContext, listOutbox } from '@crewyard/storage';
import { fetchIntegrationRefs } from './candidates.ts';
import { clientFor, configFor, repositoryFor } from './env.ts';
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

export function integrationStatus(ctx: CrewContext, repositoryId: string, env: IntegrationEnv = {}): IntegrationStatus {
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

export function getCandidate(ctx: CrewContext, candidateId: string): IntegrationCandidate {
  const candidate = candidateById(ctx.store.db, candidateId);
  if (!candidate) throw new CrewError('NOT_FOUND', `Candidate not found: ${candidateId}`);
  return candidate;
}

export function listCandidates(ctx: CrewContext, queueId: string, limit = 20): IntegrationCandidate[] {
  return listCandidatesForQueue(ctx.store.db, queueId, limit);
}

export interface PullRequestReviewInput {
  prId: string;
  types?: ReviewType[];
  force?: boolean;
}

export async function requestPullRequestReview(
  ctx: CrewContext,
  input: PullRequestReviewInput,
  deps: Omit<ReviewDeps, 'config'> & { env?: IntegrationEnv },
): Promise<RequestReviewResult> {
  const pr = requirePullRequest(ctx.store.db, input.prId);
  const repository = repositoryFor(ctx, pr.repositoryId);
  const config = configFor(ctx, deps.env ?? {}, repository.projectId);
  const base = pr.governance?.integrationBase ?? pr.baseRef;
  const client = await clientFor(ctx, deps.env ?? {}, repository);
  const liveBase = await client.getBranch(base);
  const baseSha = await fetchIntegrationRefs(ctx, repository, liveBase.sha, [pr], { kind: 'service', id: 'reviews' });
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
