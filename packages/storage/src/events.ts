import type { Database } from 'bun:sqlite';
import { type Actor, fingerprint, newId, nowIso, redactObject } from '@agent-rail/core';
import { all, one, parseJson, type Store } from './db.ts';

export const EVENT_SCHEMA_VERSION = 1;

export interface EventInput {
  type: string;
  actor: Actor;
  projectId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  prId?: string | null;
  correlationId?: string;
  causationId?: string | null;
  payload?: Record<string, unknown>;
}

export interface RailEvent {
  seq: number;
  id: string;
  schemaVersion: number;
  type: string;
  projectId: string | null;
  taskId: string | null;
  sessionId: string | null;
  prId: string | null;
  actor: Actor;
  correlationId: string;
  causationId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

interface EventRow {
  seq: number;
  id: string;
  schema_version: number;
  type: string;
  project_id: string | null;
  task_id: string | null;
  session_id: string | null;
  pr_id: string | null;
  actor_kind: Actor['kind'];
  actor_id: string;
  correlation_id: string;
  causation_id: string | null;
  payload: string;
  at: string;
}

function mapEvent(row: EventRow): RailEvent {
  return {
    seq: row.seq,
    id: row.id,
    schemaVersion: row.schema_version,
    type: row.type,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    prId: row.pr_id,
    actor: { kind: row.actor_kind, id: row.actor_id },
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    payload: parseJson(row.payload, {}),
    at: row.at,
  };
}

export function appendEvent(db: Database, input: EventInput, at: string = nowIso()): RailEvent {
  const id = newId('evt');
  const payload = redactObject(input.payload ?? {});
  const row = one<EventRow>(
    db,
    `INSERT INTO events (id, schema_version, type, project_id, task_id, session_id, pr_id, actor_kind, actor_id, correlation_id, causation_id, payload, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    id,
    EVENT_SCHEMA_VERSION,
    input.type,
    input.projectId ?? null,
    input.taskId ?? null,
    input.sessionId ?? null,
    input.prId ?? null,
    input.actor.kind,
    input.actor.id,
    input.correlationId ?? id,
    input.causationId ?? null,
    JSON.stringify(payload),
    at,
  );
  return mapEvent(row!);
}

export interface AuditInput {
  eventSeq?: number | null;
  actor: Actor;
  operator?: string | null;
  agentId?: string | null;
  profileRef?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  policyRevision?: number | null;
  action: string;
  input: unknown;
  decision: string;
  remoteResult?: unknown;
}

export function appendAudit(db: Database, input: AuditInput, at: string = nowIso()): void {
  db.query(
    `INSERT INTO audit_events (event_seq, operator, actor_kind, actor_id, agent_id, profile_ref, project_id, task_id, policy_revision, action, input_fingerprint, decision, remote_result, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventSeq ?? null,
    input.operator ?? (input.actor.kind === 'operator' ? input.actor.id : null),
    input.actor.kind,
    input.actor.id,
    input.agentId ?? null,
    input.profileRef ?? null,
    input.projectId ?? null,
    input.taskId ?? null,
    input.policyRevision ?? null,
    input.action,
    fingerprint(redactObject(input.input ?? null)),
    input.decision,
    input.remoteResult === undefined ? null : JSON.stringify(redactObject(input.remoteResult)),
    at,
  );
}

export function recordTransition(
  db: Database,
  event: EventInput,
  audit: Omit<AuditInput, 'eventSeq' | 'actor' | 'projectId' | 'taskId'> & {
    projectId?: string | null;
    taskId?: string | null;
  },
  at: string = nowIso(),
): RailEvent {
  const evt = appendEvent(db, event, at);
  appendAudit(
    db,
    {
      ...audit,
      eventSeq: evt.seq,
      actor: event.actor,
      projectId: audit.projectId ?? event.projectId ?? null,
      taskId: audit.taskId ?? event.taskId ?? null,
    },
    at,
  );
  return evt;
}

export interface EventQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  projectId?: string;
  taskId?: string;
  sessionId?: string;
  prId?: string;
  types?: string[];
  correlationId?: string;
  order?: 'asc' | 'desc';
}

export function listEvents(store: Store, query: EventQuery = {}): RailEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.afterSeq !== undefined) {
    where.push('seq > ?');
    params.push(query.afterSeq);
  }
  if (query.beforeSeq !== undefined) {
    where.push('seq < ?');
    params.push(query.beforeSeq);
  }
  for (const [col, value] of [
    ['project_id', query.projectId],
    ['task_id', query.taskId],
    ['session_id', query.sessionId],
    ['pr_id', query.prId],
    ['correlation_id', query.correlationId],
  ] as const) {
    if (value !== undefined) {
      where.push(`${col} = ?`);
      params.push(value);
    }
  }
  if (query.types && query.types.length > 0) {
    where.push(`type IN (${query.types.map(() => '?').join(',')})`);
    params.push(...query.types);
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
  const order = query.order === 'desc' ? 'DESC' : 'ASC';
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${order} LIMIT ${limit}`;
  return all<EventRow>(store.db, sql, ...params).map(mapEvent);
}

export function latestSeq(db: Database): number {
  return one<{ seq: number | null }>(db, 'SELECT MAX(seq) AS seq FROM events')?.seq ?? 0;
}
