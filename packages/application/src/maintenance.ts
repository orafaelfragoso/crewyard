import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Actor, CrewError, ensureDir, nowIso } from '@crewyard/core';
import { collectGarbage, type GarbageCollectionResult } from '@crewyard/indexing';
import { listProjects, loadProjectConfig, primaryRepository } from '@crewyard/projects';
import {
  appendEvent,
  backupDatabase,
  type CrewContext,
  LATEST_SCHEMA_VERSION,
  recordTransition,
} from '@crewyard/storage';
import { type CleanupPreview, previewCleanup } from '@crewyard/workspaces';
import { exportEvents } from './events.ts';
import { serviceStatus } from './service-control.ts';

export interface BackupResult {
  file: string;
  bytes: number;
  schemaVersion: number;
  note: string;
}

export function createBackup(ctx: CrewContext, label = 'manual'): BackupResult {
  const file = backupDatabase(ctx.store, ctx.dirs.backups, label);
  return {
    file,
    bytes: statSync(file).size,
    schemaVersion: LATEST_SCHEMA_VERSION,
    note: 'Credentials are never stored in the database; after restoring on another machine, re-run `crew account add` / provider logins.',
  };
}

export function listBackups(ctx: CrewContext): { file: string; bytes: number; modifiedAt: string }[] {
  if (!existsSync(ctx.dirs.backups)) return [];
  return readdirSync(ctx.dirs.backups)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const st = statSync(join(ctx.dirs.backups, f));
      return { file: join(ctx.dirs.backups, f), bytes: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function verifyBackup(file: string): { schemaVersion: number; integrity: string } {
  const db = new Database(file, { readonly: true });
  try {
    const integrity = (db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    const row = db.query('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    const schemaVersion = row.v ?? 0;
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new CrewError(
        'SCHEMA_TOO_NEW',
        `Backup schema v${schemaVersion} is newer than this build (v${LATEST_SCHEMA_VERSION})`,
      );
    }
    return { schemaVersion, integrity };
  } finally {
    db.close();
  }
}

export function restoreBackup(ctx: CrewContext, file: string): { restored: string; safetyBackup: string } {
  if (serviceStatus(ctx).running) {
    throw new CrewError('CONFLICT', 'Stop the service before restoring (`crew service stop`)', { retryable: false });
  }
  const check = verifyBackup(file);
  if (check.integrity !== 'ok')
    throw new CrewError('INVALID_INPUT', `Backup failed integrity check: ${check.integrity}`);
  const safety = createBackup(ctx, 'pre-restore').file;
  const target = ctx.store.path;
  ctx.store.close();
  for (const suffix of ['-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true });
  copyFileSync(file, target);
  return { restored: target, safetyBackup: safety };
}

export interface GcPlan {
  generatedAt: string;
  index: GarbageCollectionResult[];
  workspaces: CleanupPreview[];
  events: { olderThan: string; count: number; archive: string | null }[];
  backups: { keep: number; remove: string[] };
}

export async function planGarbageCollection(
  ctx: CrewContext,
  options: { apply?: boolean; actor: Actor; keepBackups?: number },
): Promise<GcPlan> {
  const apply = options.apply ?? false;
  const plan: GcPlan = {
    generatedAt: nowIso(ctx.clock),
    index: [],
    workspaces: [],
    events: [],
    backups: { keep: options.keepBackups ?? 10, remove: [] },
  };
  for (const project of listProjects(ctx)) {
    const repo = primaryRepository(ctx, project.id);
    const config = loadProjectConfig(ctx, project.id).config;
    plan.index.push(collectGarbage(ctx, { repositoryId: repo.id, dryRun: !apply }));
    plan.workspaces.push(await previewCleanup(ctx, { repositoryId: repo.id, config }));
    const cutoff = new Date(
      Date.parse(nowIso(ctx.clock)) - config.observability.keep_events_days * 86_400_000,
    ).toISOString();
    const count = (
      ctx.store.db
        .query('SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND at < ?')
        .get(project.id, cutoff) as { n: number }
    ).n;
    let archive: string | null = null;
    if (apply && count > 0) {
      ensureDir(join(ctx.dirs.artifacts, 'event-archives'));
      archive = join(ctx.dirs.artifacts, 'event-archives', `${project.name}-before-${cutoff.slice(0, 10)}.jsonl`);
      const maxSeq = (
        ctx.store.db
          .query('SELECT MAX(seq) AS s FROM events WHERE project_id = ? AND at < ?')
          .get(project.id, cutoff) as { s: number }
      ).s;
      await exportEvents(ctx, archive, { projectId: project.id, beforeSeq: maxSeq + 1 });
      ctx.store.immediate((db) => {
        db.query(
          'DELETE FROM audit_events WHERE event_seq IN (SELECT seq FROM events WHERE project_id = ? AND at < ?)',
        ).run(project.id, cutoff);
        db.query('DELETE FROM events WHERE project_id = ? AND at < ?').run(project.id, cutoff);
        appendEvent(db, {
          type: 'maintenance.events_pruned',
          actor: options.actor,
          projectId: project.id,
          payload: { cutoff, count, archive },
        });
      });
    }
    plan.events.push({ olderThan: cutoff, count, archive });
  }
  const backups = listBackups(ctx);
  plan.backups.remove = backups.slice(plan.backups.keep).map((b) => b.file);
  if (apply) {
    for (const file of plan.backups.remove) rmSync(file, { force: true });
    ctx.store.immediate((db) =>
      recordTransition(
        db,
        {
          type: 'maintenance.gc_applied',
          actor: options.actor,
          payload: { backupsRemoved: plan.backups.remove.length },
        },
        { action: 'maintenance.gc', input: { keepBackups: plan.backups.keep }, decision: 'applied' },
      ),
    );
  }
  return plan;
}
