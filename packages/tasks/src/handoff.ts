import type { HandoffKind } from '@crewyard/core';
import { CrewError, nowIso } from '@crewyard/core';
import type { CrewContext } from '@crewyard/storage';
import { type LeaseCredentials, verifyLeaseInTx } from './leases.ts';
import { type Handoff, requiresPullRequest, type TaskArtifacts, type TestEvidence } from './model.ts';
import { applyTransition, type TransitionResult } from './transitions.ts';

export interface HandoffInput {
  summary: string;
  worktreePath?: string | null;
  commits?: string[];
  testEvidence?: TestEvidence[];
  contextPackIds?: string[];
  remainingIssues?: string[];
}

export interface HandoffPolicy {
  releaseReservationsOnBlock?: boolean;
}

export interface ReportInput extends LeaseCredentials {
  kind: HandoffKind;
  handoff: HandoffInput;
  policy?: HandoffPolicy;
}

export interface ReportResult {
  taskId: string;
  kind: HandoffKind;
  handoff: Handoff;
  transitions: TransitionResult[];
}

const SHA = /^[0-9a-f]{7,64}$/;

function validateHandoff(input: HandoffInput): void {
  if (typeof input.summary !== 'string' || input.summary.trim() === '') {
    throw new CrewError('INVALID_INPUT', 'handoff.summary is required');
  }
  const bad = (input.commits ?? []).filter((c) => !SHA.test(c));
  if (bad.length > 0)
    throw new CrewError('INVALID_INPUT', 'handoff.commits must be Git object IDs', { details: { bad } });
}

function union(a: readonly string[] | undefined, b: readonly string[]): string[] {
  return [...new Set([...(a ?? []), ...b])];
}

export function report(ctx: CrewContext, input: ReportInput): ReportResult {
  validateHandoff(input.handoff);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const { task, lease } = verifyLeaseInTx(db, input, at);
    if (task.state === 'CANCEL_REQUESTED') {
      throw new CrewError('INVALID_TRANSITION', `Task ${task.id} has a pending cancellation`, {
        details: { from: task.state, allowed: ['CANCELLED'] },
        suggestion: 'Stop work and release the lease.',
      });
    }
    const actor = { kind: lease.holder_kind, id: lease.holder_id } as const;
    const handoff: Handoff = {
      kind: input.kind,
      summary: input.handoff.summary.trim(),
      worktreePath: input.handoff.worktreePath ?? task.artifacts.worktreePath ?? null,
      commits: input.handoff.commits ?? [],
      testEvidence: input.handoff.testEvidence ?? [],
      contextPackIds: input.handoff.contextPackIds ?? [],
      remainingIssues: input.handoff.remainingIssues ?? [],
      generation: lease.generation,
      reportedBy: `${actor.kind}:${actor.id}`,
      reportedAt: at,
    };
    const artifacts: TaskArtifacts = {
      ...task.artifacts,
      ...(handoff.worktreePath ? { worktreePath: handoff.worktreePath } : {}),
      commits: union(task.artifacts.commits, handoff.commits),
      testEvidence: [...(task.artifacts.testEvidence ?? []), ...handoff.testEvidence],
      contextPackIds: union(task.artifacts.contextPackIds, handoff.contextPackIds),
    };
    const base = {
      taskId: task.id,
      actor,
      handoff,
      artifacts,
      eventType: `task.handoff.${input.kind}`,
      payload: { generation: lease.generation, commits: handoff.commits, remainingIssues: handoff.remainingIssues },
    };
    const transitions: TransitionResult[] = [];
    if (input.kind === 'blocked') {
      transitions.push(
        applyTransition(
          db,
          {
            ...base,
            to: 'BLOCKED',
            reason: 'reported_blocked',
            blockerReason: [handoff.summary, ...handoff.remainingIssues].join('\n'),
            releaseReservations: input.policy?.releaseReservationsOnBlock ?? true,
          },
          at,
        ),
      );
    } else {
      transitions.push(applyTransition(db, { ...base, to: 'SUBMITTED', reason: `reported_${input.kind}` }, at));
      if (input.kind === 'completed' && !requiresPullRequest(task)) {
        transitions.push(
          applyTransition(
            db,
            { taskId: task.id, actor, to: 'DONE', reason: 'result_accepted_without_pull_request' },
            at,
          ),
        );
      }
    }
    return { taskId: task.id, kind: input.kind, handoff, transitions };
  });
}

export function submitWork(
  ctx: CrewContext,
  input: LeaseCredentials & { handoff: HandoffInput; kind?: 'ready_for_pr' | 'needs_review' },
): ReportResult {
  return report(ctx, { ...input, kind: input.kind ?? 'ready_for_pr' });
}

export function reportBlocker(
  ctx: CrewContext,
  input: LeaseCredentials & { handoff: HandoffInput; policy?: HandoffPolicy },
): ReportResult {
  return report(ctx, { ...input, kind: 'blocked' });
}

export function completeTask(ctx: CrewContext, input: LeaseCredentials & { handoff: HandoffInput }): ReportResult {
  return report(ctx, { ...input, kind: 'completed' });
}
