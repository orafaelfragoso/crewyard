import type { Database } from 'bun:sqlite';
import { CrewError } from '@crewyard/core';
import { one } from '@crewyard/storage';

export interface RemoteFreshness {
  key: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  offline: boolean;
  rateLimitResetAt: string | null;
}

interface SyncRow {
  key: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  offline: number;
  rate_limit_reset_at: string | null;
}

export const repositorySyncKey = (repositoryId: string) => `github:repo:${repositoryId}`;

export function readFreshness(db: Database, repositoryId: string): RemoteFreshness {
  const key = repositorySyncKey(repositoryId);
  const row = one<SyncRow>(db, 'SELECT * FROM sync_state WHERE key = ?', key);
  return {
    key,
    lastSuccessAt: row?.last_success_at ?? null,
    lastAttemptAt: row?.last_attempt_at ?? null,
    lastError: row?.last_error ?? null,
    offline: row?.offline === 1,
    rateLimitResetAt: row?.rate_limit_reset_at ?? null,
  };
}

export function markSyncSuccess(db: Database, repositoryId: string, at: string): void {
  db.query(
    `INSERT INTO sync_state (key, last_success_at, last_attempt_at, last_error, offline, rate_limit_reset_at) VALUES (?, ?, ?, NULL, 0, NULL)
     ON CONFLICT(key) DO UPDATE SET last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL, offline = 0, rate_limit_reset_at = NULL`,
  ).run(repositorySyncKey(repositoryId), at, at);
}

export function markSyncFailure(db: Database, repositoryId: string, error: unknown, at: string): void {
  const crew = error instanceof CrewError ? error : null;
  const offline = crew?.code === 'OFFLINE' ? 1 : 0;
  const resetAt =
    crew?.code === 'RATE_LIMITED' && typeof crew.details?.resetAt === 'string' ? crew.details.resetAt : null;
  const message = error instanceof Error ? error.message : String(error);
  db.query(
    `INSERT INTO sync_state (key, last_attempt_at, last_error, offline, rate_limit_reset_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error, offline = excluded.offline,
       rate_limit_reset_at = COALESCE(excluded.rate_limit_reset_at, sync_state.rate_limit_reset_at)`,
  ).run(repositorySyncKey(repositoryId), at, message.slice(0, 500), offline, resetAt);
}
