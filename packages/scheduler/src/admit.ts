import type { RailConfig } from '@agent-rail/config';
import type { TaskState } from '@agent-rail/core';
import { compareTaskIds, findScopeConflicts, type ScopeHolding } from '@agent-rail/tasks';
import type { BudgetStatus, SchedulerSnapshot, SchedulerTask } from './snapshot.ts';

export type WorkClass = 'implementation' | 'recovery';

export type DispatchReasonCode =
  | 'NOT_DISPATCHABLE_STATE'
  | 'ALREADY_LEASED'
  | 'AUTONOMY_OBSERVE'
  | 'INTAKE_PAUSED'
  | 'WORKERS_PAUSED'
  | 'TASK_PAUSED'
  | 'APPROVAL_PENDING'
  | 'DEPENDENCIES_UNSATISFIED'
  | 'EXCLUSIVE_SCOPE_CONFLICT'
  | 'BACKPRESSURE_OPEN_PRS'
  | 'BACKPRESSURE_QUEUE_AGE'
  | 'BUDGET_EXHAUSTED'
  | 'TASK_BUDGET_EXCEEDS_REMAINING'
  | 'CAPACITY_EXHAUSTED'
  | 'WIP_REPOSITORY'
  | 'WIP_AGENT'
  | 'WIP_ACCOUNT';

export interface Deferral {
  taskId: string;
  code: DispatchReasonCode;
  message: string;
  details: Record<string, unknown>;
}

export interface ScoreBreakdown {
  priority: number;
  override: number;
  unblock: number;
  conflictRisk: number;
  age: number;
  deadline: number;
  budget: number;
  fairness: number;
  total: number;
}

export interface Admission {
  taskId: string;
  rank: number;
  workClass: WorkClass;
  score: ScoreBreakdown;
  advisoryOverlaps: { scope: string; taskId: string }[];
}

export interface CapacityLimit {
  name: 'global' | 'project' | 'provider';
  limit: number | null;
  used: number;
  remaining: number | null;
}

export interface IntakeCapacity {
  total: number;
  implementation: number;
  recovery: number;
  reservedForRecovery: number;
  limits: CapacityLimit[];
  backpressure: {
    active: boolean;
    reason: 'BACKPRESSURE_OPEN_PRS' | 'BACKPRESSURE_QUEUE_AGE' | null;
    openPrs: number;
    maxOpenPrs: number;
    oldestQueueAgeMinutes: number | null;
    maxQueueAgeMinutes: number;
  };
  exhaustedBudget: BudgetStatus | null;
}

export interface CapacityInput {
  running: { global: number; project: number };
  openPrs: number;
  oldestQueueAgeMinutes: number | null;
  recoveryDemand: number;
  budgets: readonly BudgetStatus[];
  providerCapacity: number | null;
}

export interface AdmissionResult {
  projectId: string;
  at: string;
  fairness: RailConfig['scheduler']['fairness'];
  admitted: Admission[];
  deferred: Deferral[];
  capacity: IntakeCapacity;
}

const DISPATCHABLE_STATES: ReadonlySet<TaskState> = new Set(['READY', 'REVISION']);
const OVERRIDE_BONUS = 1000;

function budgetExhausted(budget: BudgetStatus): boolean {
  return (
    (budget.tokenLimit !== null && budget.tokensUsed >= budget.tokenLimit) ||
    (budget.costLimitUsd !== null && budget.costUsedUsd >= budget.costLimitUsd)
  );
}

export function computeIntakeCapacity(input: CapacityInput, config: RailConfig): IntakeCapacity {
  const globalLimit = config.scheduler.wip.global ?? config.agents.max_parallel;
  const projectLimit = config.scheduler.wip.project ?? null;
  const limits: CapacityLimit[] = [
    {
      name: 'global',
      limit: globalLimit,
      used: input.running.global,
      remaining: Math.max(0, globalLimit - input.running.global),
    },
    {
      name: 'project',
      limit: projectLimit,
      used: input.running.project,
      remaining: projectLimit === null ? null : Math.max(0, projectLimit - input.running.project),
    },
    {
      name: 'provider',
      limit: input.providerCapacity,
      used: 0,
      remaining: input.providerCapacity === null ? null : Math.max(0, input.providerCapacity),
    },
  ];
  const exhaustedBudget = input.budgets.find(budgetExhausted) ?? null;
  const total = exhaustedBudget ? 0 : Math.min(...limits.map((l) => l.remaining ?? Number.POSITIVE_INFINITY));
  const maxOpenPrs = config.scheduler.max_open_prs;
  const maxQueueAge = config.scheduler.max_queue_age_minutes;
  const reason =
    input.openPrs >= maxOpenPrs
      ? 'BACKPRESSURE_OPEN_PRS'
      : input.oldestQueueAgeMinutes !== null && input.oldestQueueAgeMinutes >= maxQueueAge
        ? 'BACKPRESSURE_QUEUE_AGE'
        : null;
  const reservedForRecovery = Math.min(total, config.scheduler.reserve_recovery_capacity, input.recoveryDemand);
  return {
    total,
    implementation: reason ? 0 : Math.max(0, total - reservedForRecovery),
    recovery: total,
    reservedForRecovery,
    limits,
    backpressure: {
      active: reason !== null,
      reason,
      openPrs: input.openPrs,
      maxOpenPrs,
      oldestQueueAgeMinutes: input.oldestQueueAgeMinutes,
      maxQueueAgeMinutes: maxQueueAge,
    },
    exhaustedBudget,
  };
}

function workClassOf(task: SchedulerTask): WorkClass {
  return task.state === 'REVISION' ? 'recovery' : 'implementation';
}

export function scoreTask(
  task: SchedulerTask,
  snapshot: Pick<SchedulerSnapshot, 'at' | 'projectShare'>,
  advisoryOverlapCount: number,
): ScoreBreakdown {
  const now = Date.parse(snapshot.at);
  const waitingHours = Math.max(0, (now - Date.parse(task.stateChangedAt)) / 3_600_000);
  let deadline = 0;
  if (task.deadline) {
    const hoursLeft = (Date.parse(task.deadline) - now) / 3_600_000;
    deadline = hoursLeft <= 0 ? 40 : hoursLeft <= 24 ? 25 : hoursLeft <= 72 ? 10 : 0;
  }
  const parts = {
    priority: task.effectivePriority,
    override: task.priorityOverride === null ? 0 : OVERRIDE_BONUS,
    unblock: Math.min(30, task.transitiveDependents * 5),
    conflictRisk: -Math.min(30, advisoryOverlapCount * 10),
    age: Math.round(Math.min(20, waitingHours * 0.5) * 100) / 100,
    deadline,
    budget: task.budgetTokens === null ? 0 : -Math.round(Math.min(10, task.budgetTokens / 100_000) * 100) / 100,
    fairness: -Math.round(snapshot.projectShare * 20 * 100) / 100,
  };
  const total = Math.round(Object.values(parts).reduce((sum, v) => sum + v, 0) * 100) / 100;
  return { ...parts, total };
}

function comparator(
  fairness: RailConfig['scheduler']['fairness'],
  scores: ReadonlyMap<string, ScoreBreakdown>,
): (a: SchedulerTask, b: SchedulerTask) => number {
  return (a, b) => {
    const recovery = Number(workClassOf(b) === 'recovery') - Number(workClassOf(a) === 'recovery');
    if (recovery !== 0) return recovery;
    const overrideA = a.priorityOverride === null ? 0 : 1;
    const overrideB = b.priorityOverride === null ? 0 : 1;
    if (fairness === 'fifo') {
      if (overrideA !== overrideB) return overrideB - overrideA;
      if (overrideA && a.effectivePriority !== b.effectivePriority) return b.effectivePriority - a.effectivePriority;
      const age = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      if (age !== 0) return age;
    } else if (fairness === 'strict-priority') {
      if (overrideA !== overrideB) return overrideB - overrideA;
      if (a.effectivePriority !== b.effectivePriority) return b.effectivePriority - a.effectivePriority;
    } else {
      const diff = scores.get(b.id)!.total - scores.get(a.id)!.total;
      if (diff !== 0) return diff;
    }
    return compareTaskIds(a.id, b.id);
  };
}

function policyDeferral(task: SchedulerTask, snapshot: SchedulerSnapshot): Deferral | null {
  const defer = (code: DispatchReasonCode, message: string, details: Record<string, unknown> = {}): Deferral => ({
    taskId: task.id,
    code,
    message,
    details,
  });
  if (!DISPATCHABLE_STATES.has(task.state)) {
    return defer('NOT_DISPATCHABLE_STATE', `Task is ${task.state}; only READY or REVISION tasks are dispatched`, {
      state: task.state,
    });
  }
  if (task.hasActiveLease) return defer('ALREADY_LEASED', 'Task already holds an active lease');
  if (snapshot.autonomy === 'observe')
    return defer('AUTONOMY_OBSERVE', 'Project autonomy is observe; nothing is dispatched');
  if (snapshot.intakePaused) return defer('INTAKE_PAUSED', 'Project intake is paused by the operator');
  if (snapshot.workersPaused) return defer('WORKERS_PAUSED', 'Project workers are paused by the operator');
  if (task.paused) return defer('TASK_PAUSED', 'Task is paused by the operator');
  if (!task.approvalSatisfied) return defer('APPROVAL_PENDING', 'Task is waiting for operator approval');
  if (task.blockedByDependencies.length > 0) {
    return defer('DEPENDENCIES_UNSATISFIED', `Waiting for ${task.blockedByDependencies.join(', ')} to merge`, {
      blockedBy: task.blockedByDependencies,
    });
  }
  const conflicts = findScopeConflicts(task.scopes, snapshot.reservations, task.id).exclusive;
  if (conflicts.length > 0) {
    const holders = [...new Set(conflicts.map((c) => c.conflictingTaskId))].sort(compareTaskIds);
    return defer('EXCLUSIVE_SCOPE_CONFLICT', `Exclusive scope held by ${holders.join(', ')}`, { conflicts, holders });
  }
  return null;
}

export function admitTasks(snapshot: SchedulerSnapshot, config: RailConfig): AdmissionResult {
  const deferred: Deferral[] = [];
  const eligible: SchedulerTask[] = [];
  for (const task of snapshot.tasks) {
    const deferral = policyDeferral(task, snapshot);
    if (deferral) deferred.push(deferral);
    else eligible.push(task);
  }
  const overlaps = new Map<string, { scope: string; taskId: string }[]>();
  const scores = new Map<string, ScoreBreakdown>();
  for (const task of eligible) {
    const advisory = findScopeConflicts(task.scopes, snapshot.reservations, task.id).advisory.map((c) => ({
      scope: c.scope,
      taskId: c.conflictingTaskId,
    }));
    overlaps.set(task.id, advisory);
    scores.set(task.id, scoreTask(task, snapshot, new Set(advisory.map((a) => a.taskId)).size));
  }
  eligible.sort(comparator(config.scheduler.fairness, scores));

  const capacity = computeIntakeCapacity(
    {
      running: snapshot.running,
      openPrs: snapshot.integration.openPrs,
      oldestQueueAgeMinutes: snapshot.integration.oldestQueueAgeMinutes,
      recoveryDemand: snapshot.recoveryDemand,
      budgets: snapshot.budgets,
      providerCapacity: snapshot.providerCapacity,
    },
    config,
  );
  const wip = config.scheduler.wip;
  const byRepository = { ...snapshot.running.byRepository };
  const byAgent = { ...snapshot.running.byAgent };
  const byAccount = { ...snapshot.running.byAccount };
  const admittedHoldings: ScopeHolding[] = [];
  const remainingBudget = snapshot.budgets
    .filter((b) => b.tokenLimit !== null)
    .reduce((min, b) => Math.min(min, b.tokenLimit! - b.tokensUsed), Number.POSITIVE_INFINITY);
  let used = 0;
  let implementationUsed = 0;
  const admitted: Admission[] = [];

  for (const task of eligible) {
    const workClass = workClassOf(task);
    const defer = (code: DispatchReasonCode, message: string, details: Record<string, unknown> = {}) =>
      deferred.push({ taskId: task.id, code, message, details });
    if (capacity.exhaustedBudget) {
      defer(
        'BUDGET_EXHAUSTED',
        `${capacity.exhaustedBudget.scopeKind} ${capacity.exhaustedBudget.period} budget is exhausted`,
        {
          budget: capacity.exhaustedBudget,
        },
      );
      continue;
    }
    if (task.budgetTokens !== null && task.budgetTokens > remainingBudget) {
      defer(
        'TASK_BUDGET_EXCEEDS_REMAINING',
        `Task budget ${task.budgetTokens} exceeds remaining ${remainingBudget} tokens`,
        {
          budgetTokens: task.budgetTokens,
          remainingTokens: remainingBudget,
        },
      );
      continue;
    }
    if (workClass === 'implementation' && capacity.backpressure.reason) {
      const bp = capacity.backpressure;
      defer(
        bp.reason!,
        bp.reason === 'BACKPRESSURE_OPEN_PRS'
          ? `Integration backlog: ${bp.openPrs} open PRs (max ${bp.maxOpenPrs}); new implementation is paused`
          : `Integration queue age ${bp.oldestQueueAgeMinutes}m exceeds ${bp.maxQueueAgeMinutes}m; new implementation is paused`,
        { backpressure: bp },
      );
      continue;
    }
    const poolLeft =
      workClass === 'recovery'
        ? capacity.total - used
        : Math.min(capacity.implementation - implementationUsed, capacity.total - used);
    if (poolLeft <= 0) {
      const binding =
        capacity.limits.find((l) => l.remaining !== null && l.remaining === capacity.total)?.name ?? 'global';
      defer(
        'CAPACITY_EXHAUSTED',
        workClass === 'implementation' && capacity.reservedForRecovery > 0 && capacity.total - used > 0
          ? `Remaining capacity is reserved for recovery work (${capacity.reservedForRecovery})`
          : `No ${binding} capacity left this round`,
        { binding, total: capacity.total, reservedForRecovery: capacity.reservedForRecovery },
      );
      continue;
    }
    if (task.repositoryId && wip.repository !== undefined && (byRepository[task.repositoryId] ?? 0) >= wip.repository) {
      defer('WIP_REPOSITORY', `Repository WIP limit ${wip.repository} reached`, { repositoryId: task.repositoryId });
      continue;
    }
    if (task.assignedAgentId && (byAgent[task.assignedAgentId] ?? 0) >= wip.agent) {
      defer('WIP_AGENT', `Agent ${task.assignedAgentId} is at its WIP limit ${wip.agent}`, {
        agentId: task.assignedAgentId,
      });
      continue;
    }
    if (
      task.selectedProfileId &&
      wip.account !== undefined &&
      (byAccount[task.selectedProfileId] ?? 0) >= wip.account
    ) {
      defer('WIP_ACCOUNT', `Account ${task.selectedProfileId} is at its WIP limit ${wip.account}`, {
        profileId: task.selectedProfileId,
      });
      continue;
    }
    const roundConflicts = findScopeConflicts(task.scopes, admittedHoldings, task.id).exclusive;
    if (roundConflicts.length > 0) {
      const holders = [...new Set(roundConflicts.map((c) => c.conflictingTaskId))].sort(compareTaskIds);
      defer('EXCLUSIVE_SCOPE_CONFLICT', `Exclusive scope conflicts with ${holders.join(', ')} admitted this round`, {
        holders,
        admittedThisRound: true,
      });
      continue;
    }
    used++;
    if (workClass === 'implementation') implementationUsed++;
    if (task.repositoryId) byRepository[task.repositoryId] = (byRepository[task.repositoryId] ?? 0) + 1;
    if (task.assignedAgentId) byAgent[task.assignedAgentId] = (byAgent[task.assignedAgentId] ?? 0) + 1;
    if (task.selectedProfileId) byAccount[task.selectedProfileId] = (byAccount[task.selectedProfileId] ?? 0) + 1;
    admittedHoldings.push(...task.scopes.map((s) => ({ taskId: task.id, scope: s.scope, mode: s.mode })));
    admitted.push({
      taskId: task.id,
      rank: admitted.length + 1,
      workClass,
      score: scores.get(task.id)!,
      advisoryOverlaps: overlaps.get(task.id) ?? [],
    });
  }
  deferred.sort((a, b) => compareTaskIds(a.taskId, b.taskId));
  return {
    projectId: snapshot.projectId,
    at: snapshot.at,
    fairness: config.scheduler.fairness,
    admitted,
    deferred,
    capacity,
  };
}
