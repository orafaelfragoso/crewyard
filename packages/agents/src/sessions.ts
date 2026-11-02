import type { Database } from 'bun:sqlite';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import {
  type Actor,
  type CostSource,
  CrewError,
  hashToken,
  isExpired,
  nowIso,
  redactObject,
  type UsageSource,
} from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition } from '@crewyard/storage';
import type { SessionMode } from './registry.ts';

export type SessionState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'
  | 'lost';
export const ACTIVE_SESSION_STATES: readonly SessionState[] = ['starting', 'running', 'stopping'];
export const TERMINAL_SESSION_STATES: readonly SessionState[] = ['completed', 'failed', 'cancelled', 'lost'];

export interface SessionRecord {
  id: string;
  agentId: string | null;
  profileId: string | null;
  providerId: string;
  model: string | null;
  taskId: string | null;
  leaseGeneration: number | null;
  workspaceId: string | null;
  managed: boolean;
  mode: SessionMode;
  pid: number | null;
  host: string | null;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
  lastHeartbeatAt: string | null;
  checkpoint: unknown;
  logPath: string | null;
  exitCode: number | null;
  outcome: string | null;
  errorReason: string | null;
  providerSessionId: string | null;
}

export interface SessionRow {
  id: string;
  agent_id: string | null;
  profile_id: string | null;
  provider_id: string;
  model: string | null;
  task_id: string | null;
  lease_generation: number | null;
  workspace_id: string | null;
  managed: number;
  mode: SessionMode;
  pid: number | null;
  host: string | null;
  state: SessionState;
  started_at: string;
  ended_at: string | null;
  last_heartbeat_at: string | null;
  checkpoint: string | null;
  log_path: string | null;
  exit_code: number | null;
  outcome: string | null;
  error_reason: string | null;
  session_token_hash: string | null;
  provider_session_id: string | null;
}

export function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    profileId: row.profile_id,
    providerId: row.provider_id,
    model: row.model,
    taskId: row.task_id,
    leaseGeneration: row.lease_generation,
    workspaceId: row.workspace_id,
    managed: row.managed === 1,
    mode: row.mode,
    pid: row.pid,
    host: row.host,
    state: row.state,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    checkpoint: parseJson<unknown>(row.checkpoint, null),
    logPath: row.log_path,
    exitCode: row.exit_code,
    outcome: row.outcome,
    errorReason: row.error_reason,
    providerSessionId: row.provider_session_id,
  };
}

export function sessionRow(db: Database, sessionId: string): SessionRow {
  const row = one<SessionRow>(db, 'SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!row) throw new CrewError('NOT_FOUND', `Session not found: ${sessionId}`);
  return row;
}

export function getSession(ctx: CrewContext, sessionId: string): SessionRecord {
  return mapSession(ctx.store.read((db) => sessionRow(db, sessionId)));
}

export function listSessions(
  ctx: CrewContext,
  filter: { agentId?: string; taskId?: string; state?: SessionState; limit?: number } = {},
): SessionRecord[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  for (const [col, value] of [
    ['agent_id', filter.agentId],
    ['task_id', filter.taskId],
    ['state', filter.state],
  ] as const) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
  return all<SessionRow>(
    ctx.store.db,
    `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ${limit}`,
    ...params,
  ).map(mapSession);
}

export interface SessionEventRecord {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export function appendSessionEvent(
  db: Database,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  at: string,
): number {
  const seq =
    (one<{ seq: number | null }>(db, 'SELECT MAX(seq) AS seq FROM session_events WHERE session_id = ?', sessionId)
      ?.seq ?? 0) + 1;
  db.query('INSERT INTO session_events (session_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)').run(
    sessionId,
    seq,
    type,
    JSON.stringify(redactObject(payload)),
    at,
  );
  return seq;
}

export function listSessionEvents(
  ctx: CrewContext,
  sessionId: string,
  query: { afterSeq?: number; limit?: number; types?: string[] } = {},
): SessionEventRecord[] {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const types = query.types ?? [];
  return all<{ seq: number; type: string; payload: string; at: string }>(
    ctx.store.db,
    `SELECT seq, type, payload, at FROM session_events WHERE session_id = ? AND seq > ? ${
      types.length ? `AND type IN (${types.map(() => '?').join(',')})` : ''
    } ORDER BY seq LIMIT ${limit}`,
    sessionId,
    query.afterSeq ?? 0,
    ...types,
  ).map((r) => ({ seq: r.seq, type: r.type, payload: parseJson(r.payload, {}), at: r.at }));
}

export function latestSessionEventPayload(
  db: Database,
  sessionId: string,
  type: string,
): Record<string, unknown> | null {
  const row = one<{ payload: string }>(
    db,
    'SELECT payload FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
    sessionId,
    type,
  );
  return row ? parseJson<Record<string, unknown>>(row.payload, {}) : null;
}

export interface SessionUsageRecord {
  providerId: string;
  profileId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  usageSource: UsageSource;
  costSource: CostSource;
  at: string;
}

export function getSessionUsage(ctx: CrewContext, sessionId: string): SessionUsageRecord[] {
  return all<{
    provider_id: string;
    profile_id: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_tokens: number | null;
    cost_usd: number | null;
    usage_source: UsageSource;
    cost_source: CostSource;
    at: string;
  }>(ctx.store.db, 'SELECT * FROM session_usage WHERE session_id = ? ORDER BY id', sessionId).map((r) => ({
    providerId: r.provider_id,
    profileId: r.profile_id,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    costUsd: r.cost_usd,
    usageSource: r.usage_source,
    costSource: r.cost_source,
    at: r.at,
  }));
}

export function readSessionLog(
  ctx: CrewContext,
  sessionId: string,
  options: { tailBytes?: number } = {},
): { path: string | null; content: string; truncated: boolean } {
  const session = getSession(ctx, sessionId);
  if (!session.logPath || !existsSync(session.logPath)) return { path: session.logPath, content: '', truncated: false };
  const size = statSync(session.logPath).size;
  const tail = options.tailBytes ?? 64 * 1024;
  if (size <= tail) return { path: session.logPath, content: readFileSync(session.logPath, 'utf8'), truncated: false };
  const fd = openSync(session.logPath, 'r');
  try {
    const buffer = Buffer.alloc(tail);
    readSync(fd, buffer, 0, tail, size - tail);
    return { path: session.logPath, content: buffer.toString('utf8'), truncated: true };
  } finally {
    closeSync(fd);
  }
}

export function recordCheckpoint(
  ctx: CrewContext,
  sessionId: string,
  checkpoint: Record<string, unknown>,
  actor: Actor,
): SessionRecord {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const row = sessionRow(db, sessionId);
    if (!ACTIVE_SESSION_STATES.includes(row.state)) {
      throw new CrewError(
        'INVALID_TRANSITION',
        `Session ${sessionId} is ${row.state}; checkpoints need an active session`,
      );
    }
    const safe = redactObject(checkpoint);
    db.query('UPDATE sessions SET checkpoint = ?, last_heartbeat_at = ? WHERE id = ?').run(
      JSON.stringify(safe),
      at,
      sessionId,
    );
    appendSessionEvent(db, sessionId, 'session.checkpoint', { checkpoint: safe, actor }, at);
    return mapSession(sessionRow(db, sessionId));
  });
}

export interface SessionTokenBinding {
  sessionId: string;
  agentId: string | null;
  projectId: string | null;
  taskId: string | null;
  leaseGeneration: number | null;
  expiresAt: string;
}

const NOT_AUTHORIZED = () =>
  new CrewError('NOT_AUTHORIZED', 'Session token is invalid, expired or no longer bound to an active lease', {
    suggestion: 'Managed sessions must use the CREW_SESSION_TOKEN issued at launch; agent ids are not credentials.',
  });

export function verifySessionToken(ctx: CrewContext, token: string): SessionTokenBinding {
  if (typeof token !== 'string' || !token.startsWith('crew_')) throw NOT_AUTHORIZED();
  return ctx.store.read((db) => {
    const row = one<SessionRow>(db, 'SELECT * FROM sessions WHERE session_token_hash = ?', hashToken(token));
    if (!row || !ACTIVE_SESSION_STATES.includes(row.state)) throw NOT_AUTHORIZED();
    const binding = latestSessionEventPayload(db, row.id, 'token.issued');
    const expiresAt = typeof binding?.expiresAt === 'string' ? binding.expiresAt : null;
    if (!binding || !expiresAt || isExpired(expiresAt, ctx.clock)) throw NOT_AUTHORIZED();
    const taskId = typeof binding.taskId === 'string' ? binding.taskId : null;
    const leaseGeneration = typeof binding.leaseGeneration === 'number' ? binding.leaseGeneration : null;
    if (taskId) {
      const lease = one<{ generation: number; expires_at: string }>(
        db,
        'SELECT generation, expires_at FROM leases WHERE task_id = ? AND released_at IS NULL',
        taskId,
      );
      if (!lease || lease.generation !== leaseGeneration || isExpired(lease.expires_at, ctx.clock)) {
        throw NOT_AUTHORIZED();
      }
    }
    return {
      sessionId: row.id,
      agentId: row.agent_id,
      projectId: typeof binding.projectId === 'string' ? binding.projectId : null,
      taskId,
      leaseGeneration,
      expiresAt,
    };
  });
}

export function revokeSessionToken(db: Database, sessionId: string): void {
  db.query('UPDATE sessions SET session_token_hash = NULL WHERE id = ?').run(sessionId);
}

export function sessionTransition(
  db: Database,
  row: SessionRow,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
  at: string,
): void {
  const projectId = row.task_id
    ? (one<{ project_id: string }>(db, 'SELECT project_id FROM tasks WHERE id = ?', row.task_id)?.project_id ?? null)
    : null;
  recordTransition(
    db,
    { type, actor, projectId, taskId: row.task_id, sessionId: row.id, payload: { sessionId: row.id, ...payload } },
    {
      action: type,
      input: { sessionId: row.id },
      decision: String(payload.state ?? payload.outcome ?? 'recorded'),
      agentId: row.agent_id,
      profileRef: row.profile_id,
    },
    at,
  );
}

export function closeUnsupervisedSession(
  db: Database,
  sessionId: string,
  state: 'cancelled' | 'lost' | 'orphaned',
  reason: string,
  actor: Actor,
  at: string,
): SessionRecord | null {
  const row = sessionRow(db, sessionId);
  if (TERMINAL_SESSION_STATES.includes(row.state) || row.state === state) return null;
  const terminal = state !== 'orphaned';
  db.query(
    `UPDATE sessions SET state = ?, error_reason = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
       outcome = CASE WHEN ? THEN ? ELSE outcome END WHERE id = ?`,
  ).run(state, reason, terminal ? 1 : 0, at, terminal ? 1 : 0, state, sessionId);
  if (terminal) {
    revokeSessionToken(db, sessionId);
    const hasUsage = one(db, 'SELECT id FROM session_usage WHERE session_id = ? LIMIT 1', sessionId);
    if (!hasUsage) {
      db.query(
        `INSERT INTO session_usage (session_id, provider_id, profile_id, model, usage_source, cost_source, at) VALUES (?, ?, ?, ?, 'unknown', 'unknown', ?)`,
      ).run(sessionId, row.provider_id, row.profile_id, row.model, at);
    }
  }
  appendSessionEvent(db, sessionId, `session.${state}`, { reason }, at);
  sessionTransition(db, row, `session.${state}`, actor, { state, reason }, at);
  return mapSession(sessionRow(db, sessionId));
}
