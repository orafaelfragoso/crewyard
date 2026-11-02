import {
  createBackup,
  githubRecovery,
  integrationEnv,
  listBackups,
  planGarbageCollection,
  projectForRepositoryPath,
  restoreBackup,
  verifyBackup,
} from '@crewyard/application';
import { syncRepository } from '@crewyard/integration';
import { runRecovery } from '@crewyard/recovery';
import type { Command } from 'commander';
import { confirm, emit, table } from '../output.ts';
import { action, operatorActor, withMutationOptions } from '../program.ts';

export function registerMaintenanceCommands(program: Command): void {
  const project = program.commands.find((c) => c.name() === 'project');
  project
    ?.command('sync')
    .description('synchronize this project with GitHub')
    .action(
      action(async (ctx, opts) => {
        const { repository } = await projectForRepositoryPath(ctx, opts.project as string | undefined);
        emit(opts, await syncRepository(ctx, repository.id, integrationEnv(ctx)), (s) => JSON.stringify(s, null, 2));
      }),
    );

  const backup = program
    .command('backup')
    .description('consistent local state backups (credentials are never included)');
  backup
    .command('create')
    .option('--label <label>', 'file label', 'manual')
    .action(
      action((ctx, opts) =>
        emit(opts, createBackup(ctx, String(opts.label)), (b) => [
          `${b.file} (${b.bytes} bytes, schema v${b.schemaVersion})`,
          b.note,
        ]),
      ),
    );
  backup.command('list').action(action((ctx, opts) => emit(opts, listBackups(ctx), (rows) => table(rows))));
  backup
    .command('verify <file>')
    .action(
      action((_ctx, opts, file: string) =>
        emit(opts, verifyBackup(file), (v) => `integrity ${v.integrity}, schema v${v.schemaVersion}`),
      ),
    );
  withMutationOptions(
    backup.command('restore <file>').description('replace local state with a backup (a safety backup is taken first)'),
  ).action(
    action(async (ctx, opts, file: string) => {
      await confirm(opts, `Replace the local Crewyard database with ${file}?`);
      emit(opts, restoreBackup(ctx, file), (r) => [
        `restored ${r.restored}`,
        `previous state saved to ${r.safetyBackup}`,
        'Re-authorize providers with `crew account test` if this is a new machine.',
      ]);
    }),
  );

  withMutationOptions(
    program
      .command('gc')
      .description(
        'preview (default) or apply retention: unreferenced index data, abandoned worktrees, old events, old backups',
      )
      .option('--apply', 'apply the plan (events are archived to JSONL before deletion)')
      .option('--keep-backups <n>', 'backups to keep', Number, 10),
  ).action(
    action(async (ctx, opts) => {
      if (opts.apply)
        await confirm(opts, 'Apply garbage collection? Worktrees are cleaned separately with `crew workspace clean`.');
      const plan = await planGarbageCollection(ctx, {
        apply: Boolean(opts.apply),
        actor: operatorActor(),
        keepBackups: Number(opts.keepBackups),
      });
      emit(opts, plan, (p) => JSON.stringify(p, null, 2));
    }),
  );

  program
    .command('recover')
    .description('run startup recovery now: processes, leases, workspaces, outbox and GitHub reconciliation')
    .option('--kill-orphans', 'terminate live orphaned agent process groups')
    .action(
      action(async (ctx, opts) => {
        const report = await runRecovery(ctx, {
          actor: operatorActor(),
          killLiveOrphans: Boolean(opts.killOrphans),
          remote: [githubRecovery()],
        });
        emit(opts, report, (r) =>
          r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.step} ${s.error ?? JSON.stringify(s.detail)}`),
        );
        if (!report.ok) process.exitCode = 5;
      }),
    );
}
