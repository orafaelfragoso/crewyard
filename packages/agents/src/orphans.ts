import { hostname } from 'node:os';
import { type Actor, isProcessAlive, nowIso, SYSTEM_ACTOR, terminateTree } from '@agent-rail/core';
import { all, type RailContext } from '@agent-rail/storage';
import { type AgentRuntimeConfig, defaultAgentRuntimeConfig } from './config.ts';
import { matchesRecordedProcess } from './process-identity.ts';
import { closeUnsupervisedSession, latestSessionEventPayload, type SessionRow } from './sessions.ts';
import { isLiveSupervisor, isSupervisedInProcess } from './supervisor.ts';

export interface ReapOptions {
  killLiveOrphans?: boolean;
  graceMs?: number;
  startupGraceSeconds?: number;
  config?: AgentRuntimeConfig;
  actor?: Actor;
}

export interface ReapResult {
  lost: string[];
  orphaned: string[];
  killed: string[];
  skippedUnverifiable: string[];
}

export async function reapOrphans(ctx: RailContext, options: ReapOptions = {}): Promise<ReapResult> {
  const config = options.config ?? defaultAgentRuntimeConfig();
  const actor = options.actor ?? SYSTEM_ACTOR;
  const host = hostname();
  const now = ctx.clock.now().getTime();
  const staleAfterMs = config.agents.heartbeat_interval_seconds * 3 * 1000;
  const startupGraceMs = (options.startupGraceSeconds ?? 60) * 1000;
  const result: ReapResult = { lost: [], orphaned: [], killed: [], skippedUnverifiable: [] };

  const candidates = all<SessionRow>(
    ctx.store.db,
    `SELECT * FROM sessions WHERE managed = 1 AND state IN ('starting', 'running', 'stopping', 'orphaned') AND (host = ? OR host IS NULL)`,
    host,
  );
  for (const row of candidates) {
    if (isSupervisedInProcess(row.id)) continue;
    const supervision = ctx.store.read((db) => latestSessionEventPayload(db, row.id, 'session.supervised'));
    const heartbeatAge = now - Date.parse(row.last_heartbeat_at ?? row.started_at);
    if (isLiveSupervisor(supervision?.supervisorPid) && heartbeatAge < staleAfterMs) continue;
    if (row.pid === null && now - Date.parse(row.started_at) < startupGraceMs) continue;

    const identity = row.pid === null ? null : matchesRecordedProcess(row.pid, supervision?.processIdentity);
    const alive = row.pid !== null && isProcessAlive(row.pid) && identity !== false;
    const at = nowIso(ctx.clock);
    if (!alive) {
      const closed = ctx.store.immediate((db) =>
        closeUnsupervisedSession(db, row.id, 'lost', 'lost: process exited without a live supervisor', actor, at),
      );
      if (closed) result.lost.push(row.id);
      continue;
    }
    if (options.killLiveOrphans && row.pid !== null) {
      if (identity !== true) {
        result.skippedUnverifiable.push(row.id);
      } else {
        await terminateTree(row.pid, options.graceMs ?? config.agents.cancel_grace_seconds * 1000);
        const closed = ctx.store.immediate((db) =>
          closeUnsupervisedSession(db, row.id, 'cancelled', 'cancelled: orphan terminated by reaper', actor, at),
        );
        if (closed) result.killed.push(row.id);
        continue;
      }
    }
    const marked = ctx.store.immediate((db) =>
      closeUnsupervisedSession(db, row.id, 'orphaned', 'orphaned: process alive without a live supervisor', actor, at),
    );
    if (marked) result.orphaned.push(row.id);
  }
  return result;
}
