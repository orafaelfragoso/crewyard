import { CrewError } from './errors.ts';

export const TASK_STATES = [
  'DRAFT',
  'READY',
  'CLAIMED',
  'RUNNING',
  'SUBMITTED',
  'REVIEWING',
  'REVISION',
  'BLOCKED',
  'QUEUED',
  'VALIDATING',
  'MERGED',
  'DONE',
  'CANCEL_REQUESTED',
  'CANCELLED',
  'ESCALATED',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['DONE', 'CANCELLED']);

export const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set([
  'CLAIMED',
  'RUNNING',
  'SUBMITTED',
  'REVIEWING',
  'REVISION',
  'BLOCKED',
  'QUEUED',
  'VALIDATING',
]);

export const LEASED_TASK_STATES: ReadonlySet<TaskState> = new Set(['CLAIMED', 'RUNNING', 'REVISION']);

const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['CLAIMED', 'BLOCKED', 'DRAFT', 'CANCELLED', 'ESCALATED'],
  CLAIMED: ['RUNNING', 'READY', 'BLOCKED', 'SUBMITTED', 'CANCEL_REQUESTED', 'ESCALATED'],
  RUNNING: ['SUBMITTED', 'BLOCKED', 'READY', 'CANCEL_REQUESTED', 'ESCALATED'],
  SUBMITTED: ['REVIEWING', 'QUEUED', 'BLOCKED', 'REVISION', 'DONE', 'CANCEL_REQUESTED', 'ESCALATED'],
  REVIEWING: ['REVISION', 'BLOCKED', 'QUEUED', 'DONE', 'CANCEL_REQUESTED', 'ESCALATED'],
  REVISION: ['RUNNING', 'SUBMITTED', 'BLOCKED', 'QUEUED', 'READY', 'CANCEL_REQUESTED', 'ESCALATED'],
  BLOCKED: ['READY', 'REVISION', 'QUEUED', 'REVIEWING', 'CANCEL_REQUESTED', 'ESCALATED'],
  QUEUED: ['VALIDATING', 'BLOCKED', 'REVISION', 'MERGED', 'CANCEL_REQUESTED', 'ESCALATED'],
  VALIDATING: ['MERGED', 'QUEUED', 'BLOCKED', 'REVISION', 'CANCEL_REQUESTED', 'ESCALATED'],
  MERGED: ['DONE'],
  DONE: [],
  CANCEL_REQUESTED: ['CANCELLED'],
  CANCELLED: [],
  ESCALATED: ['READY', 'REVISION', 'QUEUED', 'CANCELLED'],
};

export function allowedNextStates(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState, taskId?: string): void {
  if (canTransition(from, to)) return;
  const allowed = TRANSITIONS[from];
  throw new CrewError('INVALID_TRANSITION', `Task${taskId ? ` ${taskId}` : ''} cannot move from ${from} to ${to}`, {
    details: { from, to, allowed },
    suggestion: allowed.length > 0 ? `Allowed next states: ${allowed.join(', ')}` : `${from} is terminal`,
  });
}

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}
