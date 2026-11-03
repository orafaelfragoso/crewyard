import type { SessionRecord } from '@crewyard/agents';
import { type Actor, type FailureClass, nowIso, toCrewError } from '@crewyard/core';
import { recordFailureInTx } from '@crewyard/integration';
import { requestInterventionInTx } from '@crewyard/reviews';
import { all, type CrewContext, exec, one, parseJson } from '@crewyard/storage';
import { transitionTask } from '@crewyard/tasks';

export type RetryState = 'READY' | 'REVISION';

interface SessionFailureEvidence {
  sessionId: string;
  kind: string;
  reason: string;
  retry: boolean;
  resumeTo: RetryState;
}

const RETRIABLE: Readonly<Record<string, FailureClass>> = {
  timed_out: 'transient_provider',
  unknown: 'transient_provider',
  transient_provider: 'transient_provider',
  transient_network: 'transient_network',
  rate_limited: 'rate_limited',
};

const PERMANENT: Readonly<Record<string, FailureClass>> = {
  authentication: 'authentication',
  missing_permissions: 'missing_permissions',
};

export function sessionFailureKind(record: Pick<SessionRecord, 'state' | 'errorReason'>): string {
  if (record.state === 'completed') return 'no_changes';
  if (record.state === 'lost') return 'unknown';
  return (record.errorReason ?? 'unknown').split(':')[0]!.trim();
}

export function retryDelaySeconds(attempts: number): number {
  return Math.min(1_800, 60 * 2 ** Math.max(0, attempts - 1));
}

export function clearSessionFailures(ctx: CrewContext, taskId: string): void {
  ctx.store.immediate((db) =>
    exec(
      db,
      `DELETE FROM failure_records WHERE subject_kind = 'task' AND subject_id = ? AND fingerprint LIKE 'session:%'`,
      taskId,
    ),
  );
}

export function recordSessionFailure(
  ctx: CrewContext,
  input: {
    taskId: string;
    projectId: string;
    session: Pick<SessionRecord, 'id' | 'state' | 'errorReason'>;
    reason: string;
    resumeTo: RetryState;
    maxRetries: number;
    actor: Actor;
  },
): { kind: string; attempts: number; retry: boolean } {
  const kind = sessionFailureKind(input.session);
  const failureClass = RETRIABLE[kind] ?? PERMANENT[kind] ?? 'unknown';
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const fingerprint = `session:${kind}`;
    const previous =
      one<{ attempts: number }>(
        db,
        `SELECT attempts FROM failure_records WHERE fingerprint = ? AND subject_kind = 'task' AND subject_id = ?`,
        fingerprint,
        input.taskId,
      )?.attempts ?? 0;
    const retry = kind in RETRIABLE && previous < input.maxRetries;
    const evidence: SessionFailureEvidence = {
      sessionId: input.session.id,
      kind,
      reason: input.reason,
      retry,
      resumeTo: input.resumeTo,
    };
    const attempts = recordFailureInTx(
      db,
      { fingerprint, subjectKind: 'task', subjectId: input.taskId, failureClass, evidence: { ...evidence } },
      at,
    );
    if (!retry) {
      requestInterventionInTx(
        db,
        {
          projectId: input.projectId,
          title: `${input.taskId} is blocked after a failed agent session`,
          reasons: [
            input.reason,
            kind in RETRIABLE
              ? `${attempts} ${kind} failure(s); the retry limit is ${input.maxRetries}`
              : `failure class: ${failureClass}`,
            `Fix the cause, then run \`crew task retry ${input.taskId} --reason "<why>"\``,
          ],
          taskId: input.taskId,
        },
        input.actor,
        at,
      );
    }
    return { kind, attempts, retry };
  });
}

export function resumeSessionRetries(ctx: CrewContext, projectId: string, actor: Actor): string[] {
  const now = ctx.clock.now().getTime();
  const due = all<{ id: string; attempts: number; last_at: string; last_evidence: string | null }>(
    ctx.store.db,
    `SELECT t.id, f.attempts, f.last_at, f.last_evidence FROM tasks t
     JOIN failure_records f ON f.subject_kind = 'task' AND f.subject_id = t.id AND f.fingerprint LIKE 'session:%'
     WHERE t.project_id = ? AND t.state = 'BLOCKED' AND f.last_at >= t.state_changed_at
     ORDER BY f.last_at`,
    projectId,
  ).filter((row) => Date.parse(row.last_at) + retryDelaySeconds(row.attempts) * 1000 <= now);
  const resumed: string[] = [];
  for (const row of due) {
    const evidence = parseJson<Partial<SessionFailureEvidence>>(row.last_evidence, {});
    if (!evidence.retry || !evidence.resumeTo) continue;
    try {
      transitionTask(ctx, {
        taskId: row.id,
        to: evidence.resumeTo,
        actor,
        reason: `retry ${row.attempts} after a ${evidence.kind} session failure`,
      });
      resumed.push(row.id);
    } catch (error) {
      ctx.logger.warn('could not resume task after session failure', {
        taskId: row.id,
        error: toCrewError(error).message,
      });
    }
  }
  return resumed;
}
