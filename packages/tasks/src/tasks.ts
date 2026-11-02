import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { RailConfig } from '@agent-rail/config';
import {
  type Actor,
  nowIso,
  type Page,
  RailError,
  RISKS,
  type Risk,
  type TaskOrigin,
  type TaskState,
  TERMINAL_TASK_STATES,
  type WorkItemKind,
} from '@agent-rail/core';
import { all, exec, nextSequence, one, type RailContext, recordTransition } from '@agent-rail/storage';
import { applyRiskInTx } from './approvals.ts';
import { resolveTaskConfig } from './config.ts';
import { assertAcyclicWith } from './dag.ts';
import {
  type Approval,
  type ApprovalRow,
  type LeaseInfo,
  mapApproval,
  mapLease,
  mapReservation,
  mapTask,
  type Reservation,
  type Task,
  type TaskBudget,
  type TaskRow,
  type TaskView,
} from './model.ts';
import {
  activeLeaseRow,
  activeReservationRows,
  type DependencyStatus,
  dependencyStatuses,
  dependentIds,
  latestLeaseRow,
  requireTask,
  toView,
  toViews,
} from './queries.ts';
import { classifyRisk } from './risk.ts';
import { applyTransition } from './transitions.ts';

export interface TaskInput {
  title: string;
  objective?: string;
  acceptanceCriteria?: string[];
  repositoryId?: string | null;
  baseBranch?: string | null;
  risk?: Risk;
  priority?: number;
  dependencies?: string[];
  scopeHints?: string[];
  exclusiveResources?: string[];
  permittedTools?: string[] | null;
  requestedRole?: string | null;
  budget?: TaskBudget | null;
  kind?: WorkItemKind;
  parentId?: string | null;
  deadline?: string | null;
  scopeReason?: string;
}

export interface AddTaskInput extends TaskInput {
  projectId: string;
  goalId?: string | null;
  origin?: TaskOrigin;
  originRef?: string | null;
  initialState?: 'DRAFT' | 'READY';
  actor: Actor;
}

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 100;
const KINDS: readonly WorkItemKind[] = ['epic', 'task', 'subtask'];

function invalid(message: string, details?: Record<string, unknown>): RailError {
  return new RailError('INVALID_INPUT', message, details ? { details } : {});
}

function assertStringList(name: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw invalid(`${name} must be a list of non-empty strings`);
  }
}

export function validateTaskInput(input: Partial<TaskInput>, partial = false): void {
  if (!partial || input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim() === '') throw invalid('title is required');
    if (input.title.length > 300) throw invalid('title must be at most 300 characters');
  }
  if (
    input.priority !== undefined &&
    !(Number.isInteger(input.priority) && input.priority >= MIN_PRIORITY && input.priority <= MAX_PRIORITY)
  ) {
    throw invalid(`priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY}`);
  }
  if (input.risk !== undefined && !RISKS.includes(input.risk)) throw invalid(`risk must be one of ${RISKS.join(', ')}`);
  if (input.kind !== undefined && !KINDS.includes(input.kind)) throw invalid(`kind must be one of ${KINDS.join(', ')}`);
  if (input.deadline != null && Number.isNaN(Date.parse(input.deadline)))
    throw invalid('deadline must be an ISO-8601 timestamp');
  if (input.budget != null) {
    const { tokens, costUsd } = input.budget;
    if (tokens !== undefined && !(Number.isInteger(tokens) && tokens > 0))
      throw invalid('budget.tokens must be a positive integer');
    if (costUsd !== undefined && !(costUsd > 0)) throw invalid('budget.costUsd must be positive');
  }
  assertStringList('acceptanceCriteria', input.acceptanceCriteria);
  assertStringList('dependencies', input.dependencies);
  assertStringList('scopeHints', input.scopeHints);
  assertStringList('exclusiveResources', input.exclusiveResources);
  assertStringList('permittedTools', input.permittedTools);
}

function resolveRepository(db: Database, projectId: string, repositoryId: string | null | undefined): string | null {
  if (repositoryId === null) return null;
  if (repositoryId === undefined) {
    return (
      one<{ id: string }>(
        db,
        'SELECT id FROM repositories WHERE project_id = ? ORDER BY canonical_path LIMIT 1',
        projectId,
      )?.id ?? null
    );
  }
  const repo = one<{ project_id: string }>(db, 'SELECT project_id FROM repositories WHERE id = ?', repositoryId);
  if (!repo || repo.project_id !== projectId) {
    throw invalid(`Repository ${repositoryId} is not part of project ${projectId}`, { repositoryId, projectId });
  }
  return repositoryId;
}

export function assertKnownDependencies(db: Database, projectId: string, dependencies: readonly string[]): void {
  const unknown: string[] = [];
  for (const dep of dependencies) {
    const row = one<{ project_id: string }>(db, 'SELECT project_id FROM tasks WHERE id = ?', dep);
    if (!row || row.project_id !== projectId) unknown.push(dep);
  }
  if (unknown.length > 0) {
    throw new RailError('NOT_FOUND', `Unknown dependencies: ${unknown.join(', ')}`, {
      details: { unknown },
      suggestion: 'Dependencies must reference existing tasks of the same project.',
    });
  }
}

function replaceDependencies(db: Database, taskId: string, dependencies: readonly string[], at: string): void {
  exec(db, 'DELETE FROM task_dependencies WHERE task_id = ?', taskId);
  for (const dep of new Set(dependencies)) {
    exec(db, 'INSERT INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)', taskId, dep, at);
  }
}

export function insertTaskInTx(db: Database, input: AddTaskInput, config: RailConfig, at: string): TaskView {
  validateTaskInput(input);
  if (!one(db, 'SELECT 1 FROM projects WHERE id = ?', input.projectId)) {
    throw new RailError('NOT_FOUND', `Project not found: ${input.projectId}`);
  }
  const repositoryId = resolveRepository(db, input.projectId, input.repositoryId);
  const dependencies = [...new Set(input.dependencies ?? [])];
  assertKnownDependencies(db, input.projectId, dependencies);
  const id = `TASK-${nextSequence(db, 'task')}`;
  const artifacts = input.scopeReason ? { scopeReason: input.scopeReason } : {};
  exec(
    db,
    `INSERT INTO tasks (id, project_id, goal_id, parent_id, kind, title, objective, acceptance_criteria, repository_id,
       base_branch, risk, priority, scope_hints, exclusive_resources, permitted_tools, requested_role, state, budget,
       artifacts, origin, origin_ref, deadline, created_at, updated_at, state_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    input.goalId ?? null,
    input.parentId ?? null,
    input.kind ?? 'task',
    input.title.trim(),
    input.objective ?? '',
    JSON.stringify(input.acceptanceCriteria ?? []),
    repositoryId,
    input.baseBranch ?? null,
    input.risk ?? 'medium',
    input.priority ?? 50,
    JSON.stringify(input.scopeHints ?? []),
    JSON.stringify(input.exclusiveResources ?? []),
    input.permittedTools == null ? null : JSON.stringify(input.permittedTools),
    input.requestedRole ?? null,
    input.budget == null ? null : JSON.stringify(input.budget),
    JSON.stringify(artifacts),
    input.origin ?? 'manual',
    input.originRef ?? null,
    input.deadline ?? null,
    at,
    at,
    at,
  );
  assertAcyclicWith(db, input.projectId, id, dependencies);
  replaceDependencies(db, id, dependencies, at);
  recordTransition(
    db,
    {
      type: 'task.created',
      actor: input.actor,
      projectId: input.projectId,
      taskId: id,
      payload: { title: input.title, goalId: input.goalId ?? null, dependencies, origin: input.origin ?? 'manual' },
    },
    { action: 'task.create', input: { ...input, actor: undefined }, decision: 'accepted' },
    at,
  );
  const created = requireTask(db, id);
  applyRiskInTx(
    db,
    created,
    classifyRisk(
      { risk: created.risk, scopeHints: created.scopeHints, exclusiveResources: created.exclusiveResources },
      config,
    ),
    input.actor,
    at,
  );
  if ((input.initialState ?? 'READY') === 'READY') {
    return applyTransition(db, { taskId: id, to: 'READY', actor: input.actor, reason: 'created' }, at).task;
  }
  return toView(db, requireTask(db, id));
}

export function addTask(ctx: RailContext, input: AddTaskInput, options: { config?: RailConfig } = {}): TaskView {
  const config = resolveTaskConfig(ctx, input.projectId, options.config);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    return insertTaskInTx(db, input, config, at);
  });
}

export interface TaskFilter {
  projectId?: string;
  goalId?: string;
  repositoryId?: string;
  states?: TaskState[];
  assignedAgentId?: string;
  paused?: boolean;
  dispatchable?: boolean;
  limit?: number;
  cursor?: string | null;
}

const ID_ORDER = 'CAST(substr(id, 6) AS INTEGER)';

export function listTasks(ctx: RailContext, filter: TaskFilter = {}): Page<TaskView> {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  for (const [column, value] of [
    ['project_id', filter.projectId],
    ['goal_id', filter.goalId],
    ['repository_id', filter.repositoryId],
    ['assigned_agent_id', filter.assignedAgentId],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
    params.push(...filter.states);
  }
  if (filter.paused !== undefined) {
    where.push('paused = ?');
    params.push(filter.paused ? 1 : 0);
  }
  if (filter.dispatchable) {
    where.push(`state = 'READY' AND paused = 0 AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_id
      WHERE d.task_id = tasks.id AND dep.state NOT IN ('MERGED', 'DONE'))`);
  }
  if (filter.cursor) {
    const match = /^TASK-(\d+)$/.exec(filter.cursor);
    if (!match) throw invalid(`Invalid cursor: ${filter.cursor}`);
    where.push(`${ID_ORDER} > ?`);
    params.push(Number(match[1]));
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  const rows = all<TaskRow>(
    ctx.store.db,
    `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${ID_ORDER} LIMIT ${limit + 1}`,
    ...params,
  );
  const page = rows.slice(0, limit).map(mapTask);
  return { items: toViews(ctx.store.db, page), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export interface TaskDetail {
  task: TaskView;
  dependencies: DependencyStatus[];
  dependents: string[];
  lease: LeaseInfo | null;
  lastLease: LeaseInfo | null;
  reservations: Reservation[];
  approvals: Approval[];
  needsReconciliation: boolean;
}

export function needsReconciliation(
  task: Pick<Task, 'state'>,
  active: LeaseInfo | null,
  last: LeaseInfo | null,
): boolean {
  const leasedState = ['CLAIMED', 'RUNNING', 'REVISION', 'CANCEL_REQUESTED'].includes(task.state);
  return leasedState && active === null && last?.releaseReason === 'expired';
}

export function showTask(ctx: RailContext, taskId: string): TaskDetail {
  const db = ctx.store.db;
  const task = requireTask(db, taskId);
  const active = activeLeaseRow(db, taskId);
  const last = latestLeaseRow(db, taskId);
  const lastLease = last ? mapLease(last) : null;
  return {
    task: toView(db, task),
    dependencies: dependencyStatuses(db, taskId),
    dependents: dependentIds(db, taskId),
    lease: active ? mapLease(active) : null,
    lastLease,
    reservations: activeReservationRows(db, taskId).map(mapReservation),
    approvals: all<ApprovalRow>(
      db,
      `SELECT * FROM approvals WHERE subject_kind = 'task' AND subject_id = ? ORDER BY created_at, id`,
      taskId,
    ).map(mapApproval),
    needsReconciliation: needsReconciliation(task, active ? mapLease(active) : null, lastLease),
  };
}

function assertMutable(task: Task): void {
  if (TERMINAL_TASK_STATES.has(task.state)) {
    throw new RailError('CONFLICT', `Task ${task.id} is ${task.state} and can no longer be changed`, {
      details: { state: task.state },
    });
  }
}

function assertRevision(task: Task, expected: number | undefined): void {
  if (expected === undefined || expected === task.revision) return;
  throw new RailError('CONFLICT', `Task ${task.id} changed (revision ${task.revision}, expected ${expected})`, {
    details: { currentRevision: task.revision, expectedRevision: expected },
    suggestion: 'Reload the task and retry with the current revision.',
    retryable: true,
  });
}

function denyGithub(actor: Actor, action: string): void {
  if (actor.kind === 'github') {
    throw new RailError('POLICY_DENIED', `GitHub observations cannot ${action}`, {
      suggestion: 'Record observed PR status separately; task ownership is changed by operators or lease holders.',
    });
  }
}

function writeTaskFields(
  db: Database,
  task: Task,
  fields: Record<string, SQLQueryBindings>,
  actor: Actor,
  action: string,
  payload: Record<string, unknown>,
  at: string,
): void {
  const columns = Object.keys(fields);
  exec(
    db,
    `UPDATE tasks SET ${columns.map((c) => `${c} = ?`).join(', ')}${columns.length ? ', ' : ''}revision = revision + 1, updated_at = ? WHERE id = ?`,
    ...columns.map((c) => fields[c]!),
    at,
    task.id,
  );
  recordTransition(
    db,
    {
      type: `task.${action}`,
      actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { ...payload, revision: task.revision + 1 },
    },
    { action: `task.${action}`, input: { taskId: task.id, ...payload }, decision: 'accepted' },
    at,
  );
}

export interface UpdateTaskInput {
  patch: Partial<TaskInput>;
  expectedRevision: number;
  actor: Actor;
  config?: RailConfig;
}

const DEPENDENCY_EDITABLE_STATES: ReadonlySet<TaskState> = new Set(['DRAFT', 'READY', 'BLOCKED']);

export function updateTask(ctx: RailContext, taskId: string, input: UpdateTaskInput): TaskView {
  denyGithub(input.actor, 'edit tasks');
  validateTaskInput(input.patch, true);
  const projectId = requireTask(ctx.store.db, taskId).projectId;
  const config = resolveTaskConfig(ctx, projectId, input.config);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    assertMutable(task);
    assertRevision(task, input.expectedRevision);
    const p = input.patch;
    const fields: Record<string, SQLQueryBindings> = {};
    if (p.title !== undefined) fields.title = p.title.trim();
    if (p.objective !== undefined) fields.objective = p.objective;
    if (p.acceptanceCriteria !== undefined) fields.acceptance_criteria = JSON.stringify(p.acceptanceCriteria);
    if (p.repositoryId !== undefined) fields.repository_id = resolveRepository(db, task.projectId, p.repositoryId);
    if (p.baseBranch !== undefined) fields.base_branch = p.baseBranch;
    if (p.risk !== undefined) fields.risk = p.risk;
    if (p.priority !== undefined) fields.priority = p.priority;
    if (p.scopeHints !== undefined) fields.scope_hints = JSON.stringify(p.scopeHints);
    if (p.exclusiveResources !== undefined) fields.exclusive_resources = JSON.stringify(p.exclusiveResources);
    if (p.permittedTools !== undefined)
      fields.permitted_tools = p.permittedTools === null ? null : JSON.stringify(p.permittedTools);
    if (p.requestedRole !== undefined) fields.requested_role = p.requestedRole;
    if (p.budget !== undefined) fields.budget = p.budget === null ? null : JSON.stringify(p.budget);
    if (p.kind !== undefined) fields.kind = p.kind;
    if (p.parentId !== undefined) fields.parent_id = p.parentId;
    if (p.deadline !== undefined) fields.deadline = p.deadline;
    if (p.scopeReason !== undefined)
      fields.artifacts = JSON.stringify({ ...task.artifacts, scopeReason: p.scopeReason });
    if (p.dependencies !== undefined) {
      if (!DEPENDENCY_EDITABLE_STATES.has(task.state)) {
        throw new RailError('CONFLICT', `Dependencies of ${task.id} cannot change while it is ${task.state}`, {
          details: { state: task.state, editableStates: [...DEPENDENCY_EDITABLE_STATES] },
        });
      }
      const deps = [...new Set(p.dependencies)];
      assertKnownDependencies(db, task.projectId, deps);
      assertAcyclicWith(db, task.projectId, task.id, deps);
      replaceDependencies(db, task.id, deps, at);
    }
    writeTaskFields(db, task, fields, input.actor, 'updated', { fields: Object.keys(p).sort() }, at);
    if (p.risk !== undefined || p.scopeHints !== undefined || p.exclusiveResources !== undefined) {
      const updated = requireTask(db, task.id);
      applyRiskInTx(
        db,
        updated,
        classifyRisk(
          { risk: updated.risk, scopeHints: updated.scopeHints, exclusiveResources: updated.exclusiveResources },
          config,
        ),
        input.actor,
        at,
      );
    }
    return toView(db, requireTask(db, task.id));
  });
}

export function setPriorityOverride(
  ctx: RailContext,
  taskId: string,
  priority: number | null,
  actor: Actor,
  expectedRevision?: number,
): TaskView {
  denyGithub(actor, 'change task priority');
  if (priority !== null && !Number.isInteger(priority)) throw invalid('priority override must be an integer');
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    assertMutable(task);
    assertRevision(task, expectedRevision);
    writeTaskFields(db, task, { priority_override: priority }, actor, 'priority_overridden', { priority }, at);
    return toView(db, requireTask(db, taskId));
  });
}

export function reorderTasks(
  ctx: RailContext,
  input: { projectId: string; taskIds: string[]; actor: Actor },
): TaskView[] {
  denyGithub(input.actor, 'reorder tasks');
  if (input.taskIds.length === 0 || new Set(input.taskIds).size !== input.taskIds.length) {
    throw invalid('taskIds must be a non-empty list without duplicates');
  }
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const tasks = input.taskIds.map((id) => requireTask(db, id));
    const foreign = tasks.filter((t) => t.projectId !== input.projectId).map((t) => t.id);
    if (foreign.length > 0) throw invalid(`Tasks do not belong to project ${input.projectId}`, { taskIds: foreign });
    tasks.forEach(assertMutable);
    const top = Math.max(...tasks.map((t) => t.effectivePriority), tasks.length - 1);
    tasks.forEach((task, index) => {
      writeTaskFields(
        db,
        task,
        { priority_override: top - index },
        input.actor,
        'priority_overridden',
        { priority: top - index, reorder: true, position: index },
        at,
      );
    });
    return toViews(
      db,
      tasks.map((t) => requireTask(db, t.id)),
    );
  });
}

export function setTaskPaused(ctx: RailContext, taskId: string, paused: boolean, actor: Actor): TaskView {
  denyGithub(actor, 'pause tasks');
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    assertMutable(task);
    if (task.paused !== paused) {
      writeTaskFields(db, task, { paused: paused ? 1 : 0 }, actor, paused ? 'paused' : 'resumed', { paused }, at);
    }
    return toView(db, requireTask(db, taskId));
  });
}

export function assignAgent(ctx: RailContext, taskId: string, agentId: string | null, actor: Actor): TaskView {
  denyGithub(actor, 'assign agents');
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const task = requireTask(db, taskId);
    assertMutable(task);
    const lease = activeLeaseRow(db, taskId);
    if (lease && lease.holder_kind === 'agent' && agentId !== null && lease.holder_id !== agentId) {
      throw new RailError('LEASE_CONFLICT', `Task ${taskId} is leased by another agent`, {
        details: { generation: lease.generation, holder: lease.holder_id },
        suggestion: 'Release or force-release the lease before reassigning.',
        retryable: false,
      });
    }
    writeTaskFields(db, task, { assigned_agent_id: agentId }, actor, 'assigned', { agentId }, at);
    return toView(db, requireTask(db, taskId));
  });
}
