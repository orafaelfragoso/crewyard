import { type Actor, CrewError, nowIso, type Risk } from '@crewyard/core';
import { type CrewContext, getOutbox, type OutboxOperation, recordTransition } from '@crewyard/storage';
import { type Explanation, explainPullRequest } from './eligibility.ts';
import { repositoryFor } from './env.ts';
import { type CreatePullRequestIntent, enqueueOrReviveInTx, processIntegrationOutbox } from './outbox.ts';
import { listPullRequests, pullRequestByNumber } from './records.ts';
import { type SyncResult, syncRepository } from './sync.ts';
import type { IntegrationEnv, PullRequestRecord } from './types.ts';

export interface SubmitPullRequestInput {
  repositoryId: string;
  taskId?: string | null;
  headRef: string;
  headSha?: string | null;
  baseRef?: string;
  title: string;
  body?: string;
  draft?: boolean;
  actor: Actor;
}

export interface SubmitPullRequestResult {
  operation: OutboxOperation;
  pullRequest: PullRequestRecord | null;
  status: OutboxOperation['status'];
}

export async function submitPullRequest(
  ctx: CrewContext,
  input: SubmitPullRequestInput,
  options: { leaderId: string; env?: IntegrationEnv; execute?: boolean },
): Promise<SubmitPullRequestResult> {
  if (!/^[A-Za-z0-9._/-]+$/.test(input.headRef) || input.headRef.includes('..')) {
    throw new CrewError('INVALID_INPUT', `Invalid head branch name: ${input.headRef}`);
  }
  const repository = repositoryFor(ctx, input.repositoryId);
  const baseRef = input.baseRef ?? repository.defaultBase;
  const intent: CreatePullRequestIntent = {
    repositoryId: repository.id,
    taskId: input.taskId ?? null,
    headRef: input.headRef,
    headSha: input.headSha ?? null,
    baseRef,
    title: input.title.slice(0, 256),
    body: input.body ?? '',
    draft: input.draft ?? false,
  };
  const at = nowIso(ctx.clock);
  const operation = ctx.store.immediate((db) => {
    const op = enqueueOrReviveInTx(
      db,
      {
        kind: 'github.create_pr',
        projectId: repository.projectId,
        taskId: intent.taskId,
        subjectId: `${repository.id}:${input.headRef}`,
        intent,
        idempotencyKey: `create_pr:${repository.id}:${input.headRef}`,
        maxAttempts: 8,
      },
      at,
    );
    recordTransition(
      db,
      {
        type: 'pr.submit_requested',
        actor: input.actor,
        projectId: repository.projectId,
        taskId: intent.taskId,
        payload: { operationId: op.operationId, headRef: input.headRef, baseRef },
      },
      { action: 'pr.submit', input: intent, decision: op.status },
      at,
    );
    return op;
  });
  if (options.execute !== false) {
    await processIntegrationOutbox(ctx, { leaderId: options.leaderId, ...(options.env ? { env: options.env } : {}) });
  }
  const settled = getOutbox(ctx.store.db, operation.operationId)!;
  const number = settled.remoteCorrelation?.number;
  return {
    operation,
    status: settled.status,
    pullRequest: typeof number === 'number' ? pullRequestByNumber(ctx.store.db, repository.id, number) : null,
  };
}

export interface ImportSummaryItem {
  prId: string;
  number: number;
  title: string;
  risk: Risk;
  eligible: boolean;
  stackId: string | null;
  stackOrder: number | null;
  blockers: Explanation['blockers'];
}

export interface ImportResult {
  sync: SyncResult;
  pullRequests: ImportSummaryItem[];
  lowRiskCandidates: number[];
  blocked: number[];
  stacks: { stackId: string; numbers: number[] }[];
}

export async function importPullRequests(
  ctx: CrewContext,
  repositoryId: string,
  env: IntegrationEnv = {},
): Promise<ImportResult> {
  const sync = await syncRepository(ctx, repositoryId, env, { imported: true });
  if (!sync.ok) {
    throw new CrewError(
      sync.offline ? 'OFFLINE' : 'RATE_LIMITED',
      `Import needs GitHub: ${sync.error ?? 'unavailable'}`,
      {
        details: { lastSuccessAt: sync.freshness.lastSuccessAt },
      },
    );
  }
  const open = listPullRequests(ctx, { repositoryId, state: 'open' });
  const items = open.map((pr) => {
    const explanation = explainPullRequest(ctx, pr.id, env);
    return {
      prId: pr.id,
      number: pr.number,
      title: pr.title,
      risk: explanation.risk,
      eligible: explanation.eligible,
      stackId: pr.stackId,
      stackOrder: pr.stackOrder,
      blockers: explanation.blockers,
    };
  });
  const stacks = new Map<string, { number: number; order: number }[]>();
  for (const pr of open) {
    if (!pr.stackId) continue;
    stacks.set(pr.stackId, [...(stacks.get(pr.stackId) ?? []), { number: pr.number, order: pr.stackOrder ?? 0 }]);
  }
  const githubReady = (item: ImportSummaryItem) =>
    item.blockers.every((b) => b.source !== 'github' && b.source !== 'stack');
  return {
    sync,
    pullRequests: items,
    lowRiskCandidates: items.filter((i) => i.risk === 'low' && githubReady(i)).map((i) => i.number),
    blocked: items.filter((i) => !githubReady(i)).map((i) => i.number),
    stacks: [...stacks.entries()].map(([stackId, members]) => ({
      stackId,
      numbers: members.sort((a, b) => a.order - b.order).map((m) => m.number),
    })),
  };
}
