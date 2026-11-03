import type { Database } from 'bun:sqlite';
import { type Actor, type FailureClass, isCrewError } from '@crewyard/core';
import { requestInterventionInTx } from '@crewyard/reviews';
import { one, recordTransition } from '@crewyard/storage';
import type { PendingHook } from './env.ts';
import { invalidateCandidatesInTx, setEntryStatus } from './records.ts';
import type { PullRequestRecord, QueueEntry } from './types.ts';

export const REVISION_REQUIRED = 'REVISION_REQUIRED';

export const TRANSIENT_CLASSES: readonly FailureClass[] = [
  'transient_provider',
  'transient_network',
  'transient_ci',
  'rate_limited',
];

const ESCALATE_CLASSES: readonly FailureClass[] = [
  'authentication',
  'missing_permissions',
  'policy_violation',
  'ambiguous_remote',
  'unknown',
];

export function classifyError(error: unknown): FailureClass {
  if (!isCrewError(error)) return 'unknown';
  switch (error.code) {
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'OFFLINE':
    case 'UNAVAILABLE':
      return 'transient_network';
    case 'AMBIGUOUS_REMOTE_OUTCOME':
      return 'ambiguous_remote';
    case 'UNAUTHENTICATED':
      return 'authentication';
    case 'NOT_AUTHORIZED':
      return 'missing_permissions';
    case 'POLICY_DENIED':
    case 'APPROVAL_REQUIRED':
      return 'policy_violation';
    case 'CONFLICT':
    case 'HEAD_MISMATCH':
      return 'merge_conflict';
    case 'EXTERNAL_FAILURE':
      return error.retryable ? 'transient_network' : 'unknown';
    default:
      return 'unknown';
  }
}

export interface FailureInput {
  fingerprint: string;
  subjectKind: 'task' | 'pr' | 'candidate' | 'outbox';
  subjectId: string;
  failureClass: FailureClass;
  evidence: Record<string, unknown>;
}

export function recordFailureInTx(db: Database, input: FailureInput, at: string): number {
  const row = one<{ attempts: number }>(
    db,
    `INSERT INTO failure_records (fingerprint, subject_kind, subject_id, failure_class, attempts, last_evidence, first_at, last_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(fingerprint, subject_kind, subject_id) DO UPDATE SET attempts = attempts + 1, last_evidence = excluded.last_evidence,
       failure_class = excluded.failure_class, last_at = excluded.last_at
     RETURNING attempts`,
    input.fingerprint,
    input.subjectKind,
    input.subjectId,
    input.failureClass,
    JSON.stringify(input.evidence).slice(0, 8_000),
    at,
    at,
  );
  return row!.attempts;
}

function countedOnHead(db: Database, fingerprint: string, pr: PullRequestRecord): number | null {
  const row = one<{ attempts: number; head: string | null }>(
    db,
    `SELECT attempts, json_extract(last_evidence, '$.headSha') AS head FROM failure_records
     WHERE fingerprint = ? AND subject_kind = 'pr' AND subject_id = ?`,
    fingerprint,
    pr.id,
  );
  return row && row.head === pr.headSha ? row.attempts : null;
}

export interface FailureOutcome {
  attempts: number;
  status: QueueEntry['status'];
  capped: boolean;
}

export function applyEntryFailure(
  db: Database,
  input: {
    entry: Pick<QueueEntry, 'id' | 'attempts'>;
    pr: PullRequestRecord;
    projectId: string;
    failure: Omit<FailureInput, 'subjectKind' | 'subjectId'>;
    maxRetries: number;
    reason: string;
    actor: Actor;
    revisable?: boolean;
  },
  at: string,
  hooks: PendingHook[],
): FailureOutcome {
  const { entry, pr, failure } = input;
  const counted = input.revisable ? countedOnHead(db, failure.fingerprint, pr) : null;
  const attempts = counted ?? recordFailureInTx(db, { ...failure, subjectKind: 'pr', subjectId: pr.id }, at);
  const transient = TRANSIENT_CLASSES.includes(failure.failureClass);
  const capped = !transient && attempts >= Math.max(1, input.maxRetries);
  const revision = !capped && (input.revisable ?? failure.failureClass === 'merge_conflict');
  const status: QueueEntry['status'] = capped
    ? ESCALATE_CLASSES.includes(failure.failureClass)
      ? 'escalated'
      : 'quarantined'
    : revision
      ? 'blocked'
      : 'waiting';
  setEntryStatus(db, entry.id, status, at, {
    attempts: entry.attempts + 1,
    blockers: [
      {
        code: capped ? status.toUpperCase() : revision ? REVISION_REQUIRED : 'RETRY_PENDING',
        source: 'queue',
        message: input.reason,
        details: {
          failureClass: failure.failureClass,
          fingerprint: failure.fingerprint,
          attempts,
          headSha: pr.headSha,
        },
      },
    ],
    validatedBase: null,
    validatedHead: null,
  });
  invalidateCandidatesInTx(db, { prId: pr.id }, `failure:${failure.failureClass}`, input.actor, at);
  recordTransition(
    db,
    {
      type: capped ? `queue.entry_${status}` : 'queue.entry_failed',
      actor: input.actor,
      prId: pr.id,
      taskId: pr.taskId,
      payload: {
        entryId: entry.id,
        failureClass: failure.failureClass,
        fingerprint: failure.fingerprint,
        attempts,
        maxRetries: input.maxRetries,
        reason: input.reason,
      },
    },
    { action: 'queue.failure', input: { fingerprint: failure.fingerprint }, decision: status },
    at,
  );
  const base = pr.taskId
    ? { taskId: pr.taskId, prId: pr.id, prNumber: pr.number, repositoryId: pr.repositoryId }
    : null;
  if (capped) {
    requestInterventionInTx(
      db,
      {
        projectId: input.projectId,
        title: `PR #${pr.number} ${status} after ${attempts} identical failures`,
        reasons: [input.reason, `failure class: ${failure.failureClass}`, `fingerprint: ${failure.fingerprint}`],
        prId: pr.id,
        taskId: pr.taskId,
      },
      input.actor,
      at,
    );
    if (base) {
      hooks.push({
        name: 'onEscalated',
        event: { ...base, reason: input.reason, failureFingerprint: failure.fingerprint },
      });
    }
  } else if (revision) {
    requestInterventionInTx(
      db,
      {
        projectId: input.projectId,
        title: `PR #${pr.number} needs a revision`,
        reasons: [
          input.reason,
          ...(failure.failureClass === 'merge_conflict'
            ? ['Crewyard does not rebase proactively; the author must update the branch']
            : []),
        ],
        level: 'warning',
        prId: pr.id,
        taskId: pr.taskId,
      },
      input.actor,
      at,
    );
    if (base)
      hooks.push({
        name: 'onRevisionRequired',
        event: { ...base, reason: input.reason, details: { ...failure.evidence, fingerprint: failure.fingerprint } },
      });
  }
  return { attempts, status, capped };
}
