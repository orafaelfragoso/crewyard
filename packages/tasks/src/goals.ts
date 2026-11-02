import type { Database } from 'bun:sqlite';
import type { RailConfig } from '@agent-rail/config';
import {
  type Actor,
  type AutonomyMode,
  canTransition,
  nowIso,
  RailError,
  SYSTEM_ACTOR,
  TASK_STATES,
  type TaskState,
  TERMINAL_TASK_STATES,
} from '@agent-rail/core';
import { all, exec, nextSequence, one, parseJson, type RailContext, recordTransition } from '@agent-rail/storage';
import { decideApprovalInTx, requestApprovalInTx } from './approvals.ts';
import { resolveTaskConfig } from './config.ts';
import { findCycle, topologicalOrder } from './dag.ts';
import { type Approval, type ApprovalRow, type ApprovalStatus, mapTask, type TaskRow, type TaskView } from './model.ts';
import { projectFlags, toViews } from './queries.ts';
import { insertTaskInTx, type TaskInput, validateTaskInput } from './tasks.ts';
import { applyTransition } from './transitions.ts';

export type GoalState = 'draft' | 'planning' | 'awaiting_approval' | 'approved' | 'active' | 'completed' | 'cancelled';
export type PlanSource = 'human' | 'ai';

export interface PlanTask extends TaskInput {
  key: string;
}

export interface PlanProposal {
  summary?: string;
  tasks: PlanTask[];
}

export type PlanIssueCode =
  | 'EMPTY_PLAN'
  | 'DUPLICATE_KEY'
  | 'INVALID_FIELD'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE'
  | 'REPOSITORY_NOT_ALLOWED'
  | 'SCOPE_UNSUITABLE'
  | 'MISSING_ACCEPTANCE_CRITERIA';

export interface PlanIssue {
  code: PlanIssueCode;
  taskKey: string | null;
  message: string;
}

export interface PlanValidation {
  valid: boolean;
  issues: PlanIssue[];
  order: string[];
}

export interface StoredPlan extends PlanProposal {
  source: PlanSource;
  proposedBy: string;
  proposedAt: string;
}

export interface Goal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  state: GoalState;
  plan: StoredPlan | null;
  planErrors: PlanIssue[];
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface GoalRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: GoalState;
  plan: string | null;
  plan_errors: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function mapGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    state: row.state,
    plan: parseJson<StoredPlan | null>(row.plan, null),
    planErrors: parseJson<PlanIssue[]>(row.plan_errors, []),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    createdBy: row.created_by,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actorRef(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

function requireGoal(db: Database, goalId: string): Goal {
  const row = one<GoalRow>(db, 'SELECT * FROM goals WHERE id = ?', goalId);
  if (!row) throw new RailError('NOT_FOUND', `Goal not found: ${goalId}`, { suggestion: 'Run `rail goal list`.' });
  return mapGoal(row);
}

export function getGoal(ctx: RailContext, goalId: string): Goal {
  return requireGoal(ctx.store.db, goalId);
}

export function listGoals(ctx: RailContext, filter: { projectId?: string; states?: GoalState[] } = {}): Goal[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.projectId) {
    where.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
    params.push(...filter.states);
  }
  return all<GoalRow>(
    ctx.store.db,
    `SELECT * FROM goals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CAST(substr(id, 6) AS INTEGER)`,
    ...params,
  ).map(mapGoal);
}

export function createGoal(
  ctx: RailContext,
  input: { projectId: string; title: string; description?: string; actor: Actor },
): Goal {
  if (input.title.trim() === '') throw new RailError('INVALID_INPUT', 'Goal title is required');
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    projectFlags(db, input.projectId);
    const id = `GOAL-${nextSequence(db, 'goal')}`;
    exec(
      db,
      `INSERT INTO goals (id, project_id, title, description, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id,
      input.projectId,
      input.title.trim(),
      input.description ?? '',
      actorRef(input.actor),
      at,
      at,
    );
    recordTransition(
      db,
      {
        type: 'goal.created',
        actor: input.actor,
        projectId: input.projectId,
        payload: { goalId: id, title: input.title },
      },
      { action: 'goal.create', input: { title: input.title }, decision: 'accepted' },
      at,
    );
    return requireGoal(db, id);
  });
}

export interface PlanValidationContext {
  existingTaskIds: ReadonlySet<string>;
  allowedRepositoryIds: ReadonlySet<string>;
}

export function validatePlan(plan: PlanProposal, context: PlanValidationContext): PlanValidation {
  const issues: PlanIssue[] = [];
  const issue = (code: PlanIssueCode, taskKey: string | null, message: string) =>
    issues.push({ code, taskKey, message });
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    issue('EMPTY_PLAN', null, 'A plan must contain at least one task');
    return { valid: false, issues, order: [] };
  }
  const keys = new Set<string>();
  for (const task of plan.tasks) {
    if (typeof task.key !== 'string' || task.key.trim() === '') {
      issue('INVALID_FIELD', null, 'Every plan task needs a non-empty key');
      continue;
    }
    if (keys.has(task.key)) issue('DUPLICATE_KEY', task.key, `Duplicate task key ${task.key}`);
    if (context.existingTaskIds.has(task.key)) {
      issue('DUPLICATE_KEY', task.key, `Task key ${task.key} collides with an existing task ID`);
    }
    keys.add(task.key);
  }
  const graph = new Map<string, string[]>();
  for (const task of plan.tasks) {
    const key = task.key;
    try {
      validateTaskInput(task);
    } catch (error) {
      issue('INVALID_FIELD', key, error instanceof Error ? error.message : String(error));
    }
    if (!task.acceptanceCriteria || task.acceptanceCriteria.filter((c) => c.trim() !== '').length === 0) {
      issue('MISSING_ACCEPTANCE_CRITERIA', key, `Task ${key} has no acceptance criteria`);
    }
    const hasScope = (task.scopeHints?.length ?? 0) > 0 || (task.exclusiveResources?.length ?? 0) > 0;
    if (!hasScope && !(task.scopeReason && task.scopeReason.trim() !== '')) {
      issue('SCOPE_UNSUITABLE', key, `Task ${key} needs scope hints or an explicit scopeReason`);
    }
    if (task.repositoryId != null && !context.allowedRepositoryIds.has(task.repositoryId)) {
      issue('REPOSITORY_NOT_ALLOWED', key, `Repository ${task.repositoryId} is not part of this project`);
    }
    const deps = task.dependencies ?? [];
    for (const dep of deps) {
      if (dep === key) issue('CYCLE', key, `Task ${key} depends on itself`);
      else if (!keys.has(dep) && !context.existingTaskIds.has(dep)) {
        issue('UNKNOWN_DEPENDENCY', key, `Task ${key} depends on unknown task ${dep}`);
      }
    }
    graph.set(key, [...(graph.get(key) ?? []), ...deps.filter((d) => keys.has(d) && d !== key)]);
  }
  const cycle = findCycle(graph);
  if (cycle) issue('CYCLE', cycle[0] ?? null, `Dependency cycle: ${cycle.join(' -> ')}`);
  if (issues.length > 0) return { valid: false, issues, order: [] };
  const index = new Map(plan.tasks.map((t, i) => [t.key, i]));
  return { valid: true, issues, order: topologicalOrder(graph, (a, b) => index.get(a)! - index.get(b)!) };
}

function validationContext(db: Database, projectId: string): PlanValidationContext {
  return {
    existingTaskIds: new Set(
      all<{ id: string }>(db, 'SELECT id FROM tasks WHERE project_id = ?', projectId).map((r) => r.id),
    ),
    allowedRepositoryIds: new Set(
      all<{ id: string }>(db, 'SELECT id FROM repositories WHERE project_id = ?', projectId).map((r) => r.id),
    ),
  };
}

export function planApprovalRequired(autonomy: AutonomyMode, source: PlanSource): boolean {
  if (autonomy === 'autopilot') return false;
  if (autonomy === 'guarded') return source === 'ai';
  return true;
}

function setGoal(db: Database, goal: Goal, fields: Partial<Record<keyof GoalRow, string | null>>, at: string): void {
  const columns = Object.keys(fields) as (keyof GoalRow)[];
  exec(
    db,
    `UPDATE goals SET ${columns.map((c) => `${c} = ?`).join(', ')}, revision = revision + 1, updated_at = ? WHERE id = ?`,
    ...columns.map((c) => fields[c] ?? null),
    at,
    goal.id,
  );
}

function materializeInTx(db: Database, goal: Goal, config: RailConfig, actor: Actor, at: string): TaskView[] {
  const plan = goal.plan;
  if (!plan) throw new RailError('CONFLICT', `Goal ${goal.id} has no plan`);
  const validation = validatePlan(plan, validationContext(db, goal.projectId));
  if (!validation.valid) {
    throw new RailError('INVALID_INPUT', `Plan for ${goal.id} is no longer valid`, {
      details: { issues: validation.issues },
    });
  }
  const byKey = new Map(plan.tasks.map((t) => [t.key, t]));
  const ids = new Map<string, string>();
  const created: TaskView[] = [];
  for (const key of validation.order) {
    const { key: _key, ...task } = byKey.get(key)!;
    const view = insertTaskInTx(
      db,
      {
        ...task,
        dependencies: (task.dependencies ?? []).map((d) => ids.get(d) ?? d),
        projectId: goal.projectId,
        goalId: goal.id,
        origin: plan.source === 'ai' ? 'ai' : 'manual',
        originRef: `${goal.id}#${key}`,
        initialState: 'READY',
        actor,
      },
      config,
      at,
    );
    ids.set(key, view.id);
    created.push(view);
  }
  setGoal(db, goal, { state: 'active' }, at);
  recordTransition(
    db,
    {
      type: 'goal.materialized',
      actor,
      projectId: goal.projectId,
      payload: { goalId: goal.id, tasks: Object.fromEntries(ids) },
    },
    { action: 'goal.materialize', input: { goalId: goal.id }, decision: 'accepted' },
    at,
  );
  return created;
}

export interface ProposePlanResult {
  goal: Goal;
  validation: PlanValidation;
  approval: Approval | null;
  tasks: TaskView[];
}

const PLANNABLE_GOAL_STATES: ReadonlySet<GoalState> = new Set(['draft', 'planning', 'awaiting_approval']);

export function proposePlan(
  ctx: RailContext,
  goalId: string,
  input: { plan: PlanProposal; source: PlanSource; actor: Actor; config?: RailConfig },
): ProposePlanResult {
  const projectId = requireGoal(ctx.store.db, goalId).projectId;
  const config = resolveTaskConfig(ctx, projectId, input.config);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const goal = requireGoal(db, goalId);
    if (!PLANNABLE_GOAL_STATES.has(goal.state)) {
      throw new RailError('CONFLICT', `Goal ${goalId} is ${goal.state}; plans can no longer be proposed`, {
        details: { state: goal.state },
      });
    }
    const validation = validatePlan(input.plan, validationContext(db, goal.projectId));
    const stored: StoredPlan = {
      ...input.plan,
      source: input.source,
      proposedBy: actorRef(input.actor),
      proposedAt: at,
    };
    const pending = one<ApprovalRow>(
      db,
      `SELECT * FROM approvals WHERE subject_kind = 'goal_plan' AND subject_id = ? AND status = 'pending'`,
      goalId,
    );
    if (pending) decideApprovalInTx(db, pending.id, 'rejected', SYSTEM_ACTOR, at, 'superseded by a new plan');
    recordTransition(
      db,
      {
        type: 'goal.plan_proposed',
        actor: input.actor,
        projectId: goal.projectId,
        payload: {
          goalId,
          source: input.source,
          tasks: input.plan.tasks.length,
          valid: validation.valid,
          issues: validation.issues,
        },
      },
      { action: 'goal.propose_plan', input: stored, decision: validation.valid ? 'accepted' : 'rejected' },
      at,
    );
    if (!validation.valid) {
      setGoal(
        db,
        goal,
        { state: 'planning', plan: JSON.stringify(stored), plan_errors: JSON.stringify(validation.issues) },
        at,
      );
      return { goal: requireGoal(db, goalId), validation, approval: null, tasks: [] };
    }
    const autonomy = projectFlags(db, goal.projectId).autonomy as AutonomyMode;
    if (planApprovalRequired(autonomy, input.source)) {
      setGoal(db, goal, { state: 'awaiting_approval', plan: JSON.stringify(stored), plan_errors: '[]' }, at);
      const approval = requestApprovalInTx(
        db,
        {
          projectId: goal.projectId,
          subjectKind: 'goal_plan',
          subjectId: goalId,
          reason: `Approve ${input.plan.tasks.length}-task plan proposed by ${input.source === 'ai' ? 'an AI planner' : 'a human'}`,
          requestedBy: input.actor,
        },
        at,
      );
      return { goal: requireGoal(db, goalId), validation, approval, tasks: [] };
    }
    setGoal(
      db,
      goal,
      {
        state: 'approved',
        plan: JSON.stringify(stored),
        plan_errors: '[]',
        approved_by: `policy:autonomy-${autonomy}`,
        approved_at: at,
      },
      at,
    );
    const tasks = materializeInTx(db, requireGoal(db, goalId), config, input.actor, at);
    return { goal: requireGoal(db, goalId), validation, approval: null, tasks };
  });
}

export function decidePlan(
  ctx: RailContext,
  goalId: string,
  input: { decision: Exclude<ApprovalStatus, 'pending'>; actor: Actor; note?: string; config?: RailConfig },
): { goal: Goal; approval: Approval; tasks: TaskView[] } {
  const projectId = requireGoal(ctx.store.db, goalId).projectId;
  const config = input.decision === 'approved' ? resolveTaskConfig(ctx, projectId, input.config) : null;
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const goal = requireGoal(db, goalId);
    const pending = one<ApprovalRow>(
      db,
      `SELECT * FROM approvals WHERE subject_kind = 'goal_plan' AND subject_id = ? AND status = 'pending'`,
      goalId,
    );
    if (goal.state !== 'awaiting_approval' || !pending) {
      throw new RailError('CONFLICT', `Goal ${goalId} has no plan awaiting approval`, {
        details: { state: goal.state },
      });
    }
    const approval = decideApprovalInTx(db, pending.id, input.decision, input.actor, at, input.note);
    if (input.decision === 'rejected') {
      setGoal(db, goal, { state: 'planning' }, at);
      return { goal: requireGoal(db, goalId), approval, tasks: [] };
    }
    setGoal(db, goal, { state: 'approved', approved_by: actorRef(input.actor), approved_at: at }, at);
    const tasks = materializeInTx(db, requireGoal(db, goalId), config!, input.actor, at);
    return { goal: requireGoal(db, goalId), approval, tasks };
  });
}

export function approvePlan(ctx: RailContext, goalId: string, actor: Actor, options: { config?: RailConfig } = {}) {
  return decidePlan(ctx, goalId, { decision: 'approved', actor, ...options });
}

export function rejectPlan(ctx: RailContext, goalId: string, actor: Actor, note?: string) {
  return decidePlan(ctx, goalId, { decision: 'rejected', actor, ...(note === undefined ? {} : { note }) });
}

export function decideApproval(
  ctx: RailContext,
  approvalId: string,
  input: { decision: Exclude<ApprovalStatus, 'pending'>; actor: Actor; note?: string; config?: RailConfig },
): Approval {
  const row = one<ApprovalRow>(ctx.store.db, 'SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!row) throw new RailError('NOT_FOUND', `Approval not found: ${approvalId}`);
  if (row.subject_kind === 'goal_plan') return decidePlan(ctx, row.subject_id, input).approval;
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    return decideApprovalInTx(db, approvalId, input.decision, input.actor, at, input.note);
  });
}

export interface GoalStatus {
  goal: Goal;
  total: number;
  byState: Record<TaskState, number>;
  completed: number;
  percentComplete: number;
  blocked: string[];
  awaitingDependencies: string[];
  tasks: { id: string; title: string; state: TaskState; blockedByDependencies: string[] }[];
}

export function goalStatus(ctx: RailContext, goalId: string): GoalStatus {
  const db = ctx.store.db;
  const goal = requireGoal(db, goalId);
  const tasks = toViews(
    db,
    all<TaskRow>(db, 'SELECT * FROM tasks WHERE goal_id = ? ORDER BY CAST(substr(id, 6) AS INTEGER)', goalId).map(
      mapTask,
    ),
  );
  const byState = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
  for (const task of tasks) byState[task.state]++;
  const countable = tasks.filter((t) => t.state !== 'CANCELLED').length;
  const completed = byState.DONE + byState.MERGED;
  return {
    goal,
    total: tasks.length,
    byState,
    completed,
    percentComplete: countable === 0 ? 0 : Math.round((completed / countable) * 1000) / 10,
    blocked: tasks.filter((t) => t.state === 'BLOCKED' || t.state === 'ESCALATED').map((t) => t.id),
    awaitingDependencies: tasks
      .filter((t) => t.state === 'READY' && t.blockedByDependencies.length > 0)
      .map((t) => t.id),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      blockedByDependencies: t.blockedByDependencies,
    })),
  };
}

export interface CancelGoalResult {
  goal: Goal;
  cancelled: string[];
  cancelRequested: string[];
  untouched: string[];
}

export function cancelGoal(
  ctx: RailContext,
  goalId: string,
  input: { actor: Actor; reason: string },
): CancelGoalResult {
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const goal = requireGoal(db, goalId);
    if (goal.state === 'cancelled' || goal.state === 'completed') {
      throw new RailError('CONFLICT', `Goal ${goalId} is already ${goal.state}`);
    }
    const pending = one<ApprovalRow>(
      db,
      `SELECT * FROM approvals WHERE subject_kind = 'goal_plan' AND subject_id = ? AND status = 'pending'`,
      goalId,
    );
    if (pending) decideApprovalInTx(db, pending.id, 'rejected', SYSTEM_ACTOR, at, 'goal cancelled');
    const result: CancelGoalResult = { goal, cancelled: [], cancelRequested: [], untouched: [] };
    const tasks = all<TaskRow>(
      db,
      'SELECT * FROM tasks WHERE goal_id = ? ORDER BY CAST(substr(id, 6) AS INTEGER)',
      goalId,
    ).map(mapTask);
    const reason = `goal cancelled: ${input.reason}`;
    for (const task of tasks) {
      if (TERMINAL_TASK_STATES.has(task.state) || task.state === 'CANCEL_REQUESTED') {
        result.untouched.push(task.id);
      } else if (canTransition(task.state, 'CANCELLED')) {
        applyTransition(db, { taskId: task.id, to: 'CANCELLED', actor: input.actor, reason }, at);
        result.cancelled.push(task.id);
      } else if (canTransition(task.state, 'CANCEL_REQUESTED')) {
        applyTransition(db, { taskId: task.id, to: 'CANCEL_REQUESTED', actor: input.actor, reason }, at);
        result.cancelRequested.push(task.id);
      } else {
        result.untouched.push(task.id);
      }
    }
    setGoal(db, goal, { state: 'cancelled' }, at);
    recordTransition(
      db,
      {
        type: 'goal.cancelled',
        actor: input.actor,
        projectId: goal.projectId,
        payload: { goalId, reason: input.reason, ...result, goal: undefined },
      },
      { action: 'goal.cancel', input: { goalId, reason: input.reason }, decision: 'accepted' },
      at,
    );
    return { ...result, goal: requireGoal(db, goalId) };
  });
}
