import { nowIso, type TaskState } from '@agent-rail/core';
import { all, latestSeq, listWorkers, one, parseJson, type RailContext } from '@agent-rail/storage';

export interface Alert {
  level: 'info' | 'warning' | 'error' | 'action_required';
  title: string;
  body: string;
  at: string;
  taskId: string | null;
  prId: string | null;
}

export interface OverviewProjection {
  cursor: number;
  generatedAt: string;
  projects: { id: string; name: string; intakePaused: boolean; workersPaused: boolean; autonomy: string }[];
  tasksByState: Partial<Record<TaskState, number>>;
  runningSessions: number;
  openPrs: number;
  queued: number;
  mergedLast24h: number;
  pendingApprovals: number;
  service: { running: boolean; lastHeartbeatAt: string | null; workerId: string | null };
  alerts: Alert[];
}

export function overviewProjection(ctx: RailContext, projectId?: string | null): OverviewProjection {
  const db = ctx.store.db;
  const pf = projectId ? 'WHERE project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const at = nowIso(ctx.clock);
  const dayAgo = new Date(Date.parse(at) - 86_400_000).toISOString();
  const services = listWorkers(ctx.store, 'service').filter((w) => w.status === 'running');
  const freshest = services[0];
  const serviceAlive = !!freshest && Date.parse(at) - Date.parse(freshest.lastHeartbeatAt) < 120_000;
  return {
    cursor: latestSeq(db),
    generatedAt: at,
    projects: all<{ id: string; name: string; intake_paused: number; workers_paused: number; autonomy: string }>(
      db,
      `SELECT id, name, intake_paused, workers_paused, autonomy FROM projects ${projectId ? 'WHERE id = ?' : ''} ORDER BY name`,
      ...params,
    ).map((p) => ({
      id: p.id,
      name: p.name,
      intakePaused: p.intake_paused === 1,
      workersPaused: p.workers_paused === 1,
      autonomy: p.autonomy,
    })),
    tasksByState: Object.fromEntries(
      all<{ state: TaskState; n: number }>(
        db,
        `SELECT state, COUNT(*) AS n FROM tasks ${pf} GROUP BY state`,
        ...params,
      ).map((r) => [r.state, r.n]),
    ),
    runningSessions: one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.state IN ('starting', 'running') ${projectId ? 'AND t.project_id = ?' : ''}`,
      ...params,
    )!.n,
    openPrs: one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id WHERE pr.state = 'open' ${projectId ? 'AND r.project_id = ?' : ''}`,
      ...params,
    )!.n,
    queued: one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM queue_entries qe JOIN integration_queues q ON q.id = qe.queue_id JOIN repositories r ON r.id = q.repository_id
       WHERE qe.status NOT IN ('merged', 'removed') ${projectId ? 'AND r.project_id = ?' : ''}`,
      ...params,
    )!.n,
    mergedLast24h: one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM pull_requests pr JOIN repositories r ON r.id = pr.repository_id
       WHERE pr.state = 'merged' AND pr.merge_commit_sha IS NOT NULL AND pr.merged_at >= ? ${projectId ? 'AND r.project_id = ?' : ''}`,
      dayAgo,
      ...params,
    )!.n,
    pendingApprovals: one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' ${projectId ? 'AND project_id = ?' : ''}`,
      ...params,
    )!.n,
    service: {
      running: serviceAlive,
      lastHeartbeatAt: freshest?.lastHeartbeatAt ?? null,
      workerId: freshest?.workerId ?? null,
    },
    alerts: all<{
      level: Alert['level'];
      title: string;
      body: string;
      created_at: string;
      task_id: string | null;
      pr_id: string | null;
    }>(
      db,
      `SELECT level, title, body, created_at, task_id, pr_id FROM notifications WHERE read_at IS NULL ${projectId ? 'AND project_id = ?' : ''}
       ORDER BY created_at DESC LIMIT 20`,
      ...params,
    ).map((n) => ({
      level: n.level,
      title: n.title,
      body: n.body,
      at: n.created_at,
      taskId: n.task_id,
      prId: n.pr_id,
    })),
  };
}

export interface TaskBoardRow {
  id: string;
  title: string;
  state: TaskState;
  owner: string | null;
  priority: number;
  risk: string;
  dependencies: string[];
  ageHours: number;
  attempts: number;
  blocker: string | null;
  paused: boolean;
}

export function taskBoard(
  ctx: RailContext,
  options: { projectId?: string | null; search?: string; limit?: number; offset?: number } = {},
): TaskBoardRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.projectId) {
    where.push('t.project_id = ?');
    params.push(options.projectId);
  }
  if (options.search) {
    where.push('(t.id LIKE ? OR t.title LIKE ? OR t.state LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  const at = Date.parse(nowIso(ctx.clock));
  const rows = all<{
    id: string;
    title: string;
    state: TaskState;
    owner: string | null;
    priority: number;
    priority_override: number | null;
    risk: string;
    deps: string | null;
    created_at: string;
    attempts: number;
    blocker_reason: string | null;
    paused: number;
  }>(
    ctx.store.db,
    `SELECT t.id, t.title, t.state, COALESCE(a.name, t.assigned_agent_id) AS owner, t.priority, t.priority_override, t.risk,
       (SELECT json_group_array(depends_on_id) FROM task_dependencies d WHERE d.task_id = t.id) AS deps,
       t.created_at, t.attempts, t.blocker_reason, t.paused
     FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE t.state WHEN 'DONE' THEN 2 WHEN 'CANCELLED' THEN 2 ELSE 1 END, COALESCE(t.priority_override, t.priority) DESC, t.id
     LIMIT ? OFFSET ?`,
    ...params,
    options.limit ?? 200,
    options.offset ?? 0,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    owner: r.owner,
    priority: r.priority_override ?? r.priority,
    risk: r.risk,
    dependencies: parseJson<string[]>(r.deps, []),
    ageHours: Math.round(((at - Date.parse(r.created_at)) / 3_600_000) * 10) / 10,
    attempts: r.attempts,
    blocker: r.blocker_reason,
    paused: r.paused === 1,
  }));
}

export interface SessionRow {
  id: string;
  agent: string | null;
  providerId: string;
  profile: string | null;
  model: string | null;
  taskId: string | null;
  state: string;
  managed: boolean;
  pid: number | null;
  startedAt: string;
  lastHeartbeatAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageStatus: 'measured' | 'unknown';
  lastOutput: string | null;
}

export function sessionRows(ctx: RailContext, options: { active?: boolean; limit?: number } = {}): SessionRow[] {
  const rows = all<{
    id: string;
    agent: string | null;
    provider_id: string;
    profile: string | null;
    model: string | null;
    task_id: string | null;
    state: string;
    managed: number;
    pid: number | null;
    started_at: string;
    last_heartbeat_at: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    measured: number;
    last_output: string | null;
  }>(
    ctx.store.db,
    `SELECT s.id, a.name AS agent, s.provider_id, p.name AS profile, s.model, s.task_id, s.state, s.managed, s.pid, s.started_at, s.last_heartbeat_at,
       (SELECT SUM(input_tokens) FROM session_usage u WHERE u.session_id = s.id) AS input_tokens,
       (SELECT SUM(output_tokens) FROM session_usage u WHERE u.session_id = s.id) AS output_tokens,
       (SELECT COUNT(*) FROM session_usage u WHERE u.session_id = s.id AND u.usage_source = 'measured') AS measured,
       (SELECT payload FROM session_events e WHERE e.session_id = s.id AND e.type IN ('message', 'log', 'tool') ORDER BY e.seq DESC LIMIT 1) AS last_output
     FROM sessions s LEFT JOIN agents a ON a.id = s.agent_id LEFT JOIN provider_profiles p ON p.id = s.profile_id
     ${options.active ? "WHERE s.state IN ('starting', 'running', 'stopping')" : ''}
     ORDER BY s.started_at DESC LIMIT ?`,
    options.limit ?? 100,
  );
  return rows.map((r) => {
    const last = parseJson<{ text?: string; name?: string; detail?: string } | null>(r.last_output, null);
    return {
      id: r.id,
      agent: r.agent,
      providerId: r.provider_id,
      profile: r.profile,
      model: r.model,
      taskId: r.task_id,
      state: r.state,
      managed: r.managed === 1,
      pid: r.pid,
      startedAt: r.started_at,
      lastHeartbeatAt: r.last_heartbeat_at,
      inputTokens: r.measured > 0 ? r.input_tokens : null,
      outputTokens: r.measured > 0 ? r.output_tokens : null,
      usageStatus: r.measured > 0 ? 'measured' : 'unknown',
      lastOutput: last ? (last.text ?? (last.name ? `${last.name} ${last.detail ?? ''}`.trim() : null)) : null,
    };
  });
}

export interface QueueRow {
  entryId: string;
  queueId: string;
  baseBranch: string;
  mode: string;
  prNumber: number;
  prTitle: string;
  url: string | null;
  status: string;
  priority: number;
  checks: string | null;
  baseSha: string | null;
  headSha: string;
  stackId: string | null;
  stackOrder: number | null;
  blockers: { code: string; message: string }[];
}

export function queueRows(ctx: RailContext, projectId?: string | null): QueueRow[] {
  return all<{
    id: string;
    queue_id: string;
    base_branch: string;
    mode: string;
    number: number;
    title: string;
    url: string | null;
    status: string;
    priority: number;
    checks_state: string | null;
    base_sha: string | null;
    head_sha: string;
    stack_id: string | null;
    stack_order: number | null;
    blockers: string;
  }>(
    ctx.store.db,
    `SELECT qe.id, qe.queue_id, q.base_branch, q.mode, pr.number, pr.title, pr.url, qe.status, qe.priority, pr.checks_state,
       pr.base_sha, pr.head_sha, qe.stack_id, qe.stack_order, qe.blockers
     FROM queue_entries qe JOIN integration_queues q ON q.id = qe.queue_id JOIN pull_requests pr ON pr.id = qe.pr_id
     JOIN repositories r ON r.id = q.repository_id
     WHERE qe.status NOT IN ('merged', 'removed') ${projectId ? 'AND r.project_id = ?' : ''}
     ORDER BY q.base_branch, CASE WHEN qe.stack_id IS NULL THEN 1 ELSE 0 END, qe.stack_id, qe.stack_order, qe.priority DESC, qe.enqueued_at`,
    ...(projectId ? [projectId] : []),
  ).map((r) => ({
    entryId: r.id,
    queueId: r.queue_id,
    baseBranch: r.base_branch,
    mode: r.mode,
    prNumber: r.number,
    prTitle: r.title,
    url: r.url,
    status: r.status,
    priority: r.priority,
    checks: r.checks_state,
    baseSha: r.base_sha,
    headSha: r.head_sha,
    stackId: r.stack_id,
    stackOrder: r.stack_order,
    blockers: parseJson(r.blockers, []),
  }));
}

export interface ProjectRow {
  id: string;
  name: string;
  repository: string;
  defaultBase: string;
  autonomy: string;
  intakePaused: boolean;
  backlog: number;
  indexedCommit: string | null;
  indexedAt: string | null;
  indexStatus: string;
  policyRevision: number;
}

export function projectRows(ctx: RailContext): ProjectRow[] {
  return all<{
    id: string;
    name: string;
    canonical_path: string;
    default_base: string;
    autonomy: string;
    intake_paused: number;
    policy_revision: number;
    backlog: number;
    commit_sha: string | null;
    completed_at: string | null;
    status: string | null;
  }>(
    ctx.store.db,
    `SELECT p.id, p.name, r.canonical_path, r.default_base, p.autonomy, p.intake_paused, p.policy_revision,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.state IN ('DRAFT', 'READY')) AS backlog,
       s.commit_sha, s.completed_at, s.status
     FROM projects p JOIN repositories r ON r.project_id = p.id
     LEFT JOIN repository_snapshots s ON s.id = (
       SELECT id FROM repository_snapshots WHERE repository_id = r.id AND status = 'available' ORDER BY completed_at DESC LIMIT 1)
     ORDER BY p.name`,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    repository: r.canonical_path,
    defaultBase: r.default_base,
    autonomy: r.autonomy,
    intakePaused: r.intake_paused === 1,
    backlog: r.backlog,
    indexedCommit: r.commit_sha,
    indexedAt: r.completed_at,
    indexStatus: r.status ?? 'missing',
    policyRevision: r.policy_revision,
  }));
}
