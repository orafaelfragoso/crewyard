import type { RailConfig } from '@agent-rail/config';
import { type AutonomyMode, nowIso, type Risk, type TaskState } from '@agent-rail/core';
import { all, one, type RailContext } from '@agent-rail/storage';
import {
  activeLeaseRow,
  mapTask,
  projectDependencyGraph,
  projectFlags,
  requestedScopes,
  resolveTaskConfig,
  type ScopeHolding,
  type ScopeRequest,
  type TaskRow,
  taskApprovalSatisfied,
  toViews,
  transitiveDependents,
} from '@agent-rail/tasks';

export interface SchedulerTask {
  id: string;
  projectId: string;
  repositoryId: string | null;
  state: TaskState;
  title: string;
  risk: Risk;
  priority: number;
  priorityOverride: number | null;
  effectivePriority: number;
  createdAt: string;
  stateChangedAt: string;
  deadline: string | null;
  paused: boolean;
  assignedAgentId: string | null;
  selectedProfileId: string | null;
  budgetTokens: number | null;
  scopes: ScopeRequest[];
  blockedByDependencies: string[];
  approvalSatisfied: boolean;
  hasActiveLease: boolean;
  transitiveDependents: number;
}

export interface BudgetStatus {
  scopeKind: 'global' | 'project';
  scopeId: string;
  period: 'day' | 'month' | 'total';
  tokenLimit: number | null;
  tokensUsed: number;
  costLimitUsd: number | null;
  costUsedUsd: number;
  usageComplete: boolean;
}

export interface RunningCounts {
  global: number;
  project: number;
  byRepository: Record<string, number>;
  byAgent: Record<string, number>;
  byAccount: Record<string, number>;
}

export interface SchedulerSnapshot {
  projectId: string;
  at: string;
  autonomy: AutonomyMode;
  intakePaused: boolean;
  workersPaused: boolean;
  tasks: SchedulerTask[];
  reservations: ScopeHolding[];
  running: RunningCounts;
  integration: { openPrs: number; queueDepth: number; oldestQueueAgeMinutes: number | null };
  recoveryDemand: number;
  budgets: BudgetStatus[];
  providerCapacity: number | null;
  projectShare: number;
}

export interface SnapshotOptions {
  config?: RailConfig;
  providerCapacity?: number | null;
  impactScopes?: Record<string, string[]>;
}

function periodStart(at: string, period: BudgetStatus['period']): string {
  if (period === 'total') return '0000-01-01T00:00:00Z';
  return period === 'day' ? `${at.slice(0, 10)}T00:00:00Z` : `${at.slice(0, 7)}-01T00:00:00Z`;
}

function budgetStatuses(ctx: RailContext, projectId: string, at: string): BudgetStatus[] {
  const db = ctx.store.db;
  const rows = all<{
    scope_kind: 'global' | 'project';
    scope_id: string;
    period: BudgetStatus['period'];
    token_limit: number | null;
    cost_limit_usd: number | null;
  }>(
    db,
    `SELECT scope_kind, scope_id, period, token_limit, cost_limit_usd FROM budgets
     WHERE scope_kind = 'global' OR (scope_kind = 'project' AND scope_id = ?) ORDER BY scope_kind, period`,
    projectId,
  );
  return rows.map((row) => {
    const usage = one<{ tokens: number | null; cost: number | null; unknown: number }>(
      db,
      `SELECT SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS tokens, SUM(COALESCE(u.cost_usd, 0)) AS cost,
              SUM(CASE WHEN u.input_tokens IS NULL OR u.output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown
       FROM session_usage u JOIN sessions s ON s.id = u.session_id LEFT JOIN tasks t ON t.id = s.task_id
       WHERE u.at >= ? ${row.scope_kind === 'project' ? 'AND t.project_id = ?' : ''}`,
      ...(row.scope_kind === 'project' ? [periodStart(at, row.period), projectId] : [periodStart(at, row.period)]),
    );
    return {
      scopeKind: row.scope_kind,
      scopeId: row.scope_id,
      period: row.period,
      tokenLimit: row.token_limit,
      tokensUsed: usage?.tokens ?? 0,
      costLimitUsd: row.cost_limit_usd,
      costUsedUsd: usage?.cost ?? 0,
      usageComplete: (usage?.unknown ?? 0) === 0,
    };
  });
}

function countBy(rows: { key: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { key } of rows) if (key !== null) out[key] = (out[key] ?? 0) + 1;
  return out;
}

export function buildSchedulerSnapshot(
  ctx: RailContext,
  projectId: string,
  options: SnapshotOptions = {},
): SchedulerSnapshot {
  const config = resolveTaskConfig(ctx, projectId, options.config);
  const db = ctx.store.db;
  const at = nowIso(ctx.clock);
  const flags = projectFlags(db, projectId);
  const rows = all<TaskRow>(
    db,
    `SELECT * FROM tasks WHERE project_id = ? AND state NOT IN ('DONE', 'CANCELLED') ORDER BY CAST(substr(id, 6) AS INTEGER)`,
    projectId,
  );
  const views = toViews(db, rows.map(mapTask));
  const openIds = new Set(views.map((v) => v.id));
  const graph = new Map(
    [...projectDependencyGraph(db, projectId)]
      .filter(([id]) => openIds.has(id))
      .map(([id, deps]) => [id, deps.filter((d) => openIds.has(d))]),
  );
  const dependents = transitiveDependents(graph);
  const tasks: SchedulerTask[] = views.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    repositoryId: task.repositoryId,
    state: task.state,
    title: task.title,
    risk: task.risk,
    priority: task.priority,
    priorityOverride: task.priorityOverride,
    effectivePriority: task.effectivePriority,
    createdAt: task.createdAt,
    stateChangedAt: task.stateChangedAt,
    deadline: task.deadline,
    paused: task.paused,
    assignedAgentId: task.assignedAgentId,
    selectedProfileId: task.selectedProfileId,
    budgetTokens: task.budget?.tokens ?? null,
    scopes: requestedScopes(task, config, options.impactScopes?.[task.id] ?? []),
    blockedByDependencies: task.blockedByDependencies,
    approvalSatisfied: taskApprovalSatisfied(db, task).satisfied,
    hasActiveLease: activeLeaseRow(db, task.id) !== null,
    transitiveDependents: dependents.get(task.id) ?? 0,
  }));

  const leases = all<{
    project_id: string;
    repository_id: string | null;
    holder_kind: string;
    holder_id: string;
    profile: string | null;
  }>(
    db,
    `SELECT t.project_id, t.repository_id, l.holder_kind, l.holder_id, t.selected_profile_id AS profile
     FROM leases l JOIN tasks t ON t.id = l.task_id WHERE l.released_at IS NULL`,
  );
  const projectLeases = leases.filter((l) => l.project_id === projectId);
  const queue = one<{ depth: number; oldest: string | null }>(
    db,
    `SELECT COUNT(*) AS depth, MIN(e.enqueued_at) AS oldest FROM queue_entries e
     JOIN integration_queues q ON q.id = e.queue_id JOIN repositories r ON r.id = q.repository_id
     WHERE r.project_id = ? AND e.status NOT IN ('merged', 'removed')`,
    projectId,
  );
  const openPrs =
    one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
       WHERE r.project_id = ? AND p.state = 'open'`,
      projectId,
    )?.n ?? 0;

  return {
    projectId,
    at,
    autonomy: flags.autonomy as AutonomyMode,
    intakePaused: flags.intakePaused,
    workersPaused: flags.workersPaused,
    tasks,
    reservations: all<{ task_id: string; scope: string; mode: 'advisory' | 'exclusive' }>(
      db,
      'SELECT task_id, scope, mode FROM task_scope_reservations WHERE project_id = ? AND released_at IS NULL ORDER BY scope, task_id',
      projectId,
    ).map((r) => ({ taskId: r.task_id, scope: r.scope, mode: r.mode })),
    running: {
      global: leases.length,
      project: projectLeases.length,
      byRepository: countBy(projectLeases.map((l) => ({ key: l.repository_id }))),
      byAgent: countBy(leases.filter((l) => l.holder_kind === 'agent').map((l) => ({ key: l.holder_id }))),
      byAccount: countBy(leases.map((l) => ({ key: l.profile }))),
    },
    integration: {
      openPrs,
      queueDepth: queue?.depth ?? 0,
      oldestQueueAgeMinutes: queue?.oldest
        ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(queue.oldest)) / 60_000))
        : null,
    },
    recoveryDemand: tasks.filter((t) => t.state === 'REVISION' && !t.hasActiveLease).length,
    budgets: budgetStatuses(ctx, projectId, at),
    providerCapacity: options.providerCapacity ?? null,
    projectShare: leases.length === 0 ? 0 : projectLeases.length / leases.length,
  };
}
