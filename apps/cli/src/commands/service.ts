import {
  CrewService,
  DEFAULT_EXECUTION_LIMITS,
  defaultServiceOptions,
  installServiceUnit,
  serviceStatus,
  startService,
  stopService,
  uninstallServiceUnit,
} from '@crewyard/application';
import type { Command } from 'commander';
import { confirm, emit, keyValues } from '../output.ts';
import { action, withMutationOptions } from '../program.ts';

export function registerServiceCommands(program: Command): void {
  const service = program
    .command('service')
    .description('the long-running local worker for dispatch, sync, queue and recovery');
  service
    .command('run')
    .description('run the service in the foreground (what `service start` and the user service execute)')
    .option('--tick <seconds>', 'scheduling cycle interval', Number)
    .option('--workers <count>', 'maximum concurrent execution workers', Number)
    .option('--workers-per-project <count>', 'maximum workers for one project', Number)
    .option('--workers-per-domain <count>', 'maximum workers for one domain within a project', Number)
    .option('--worker-timeout <seconds>', 'execution worker deadline', Number)
    .option('--shutdown-grace <seconds>', 'grace before verified worker termination', Number)
    .option('--no-dispatch', 'do not launch agent sessions (sync, queue and recovery only)')
    .action(
      action(async (ctx, opts) => {
        const svc = new CrewService(ctx, {
          ...defaultServiceOptions(),
          execution: {
            ...DEFAULT_EXECUTION_LIMITS,
            ...(opts.workers !== undefined ? { global: Number(opts.workers) } : {}),
            ...(opts.workersPerProject !== undefined ? { perProject: Number(opts.workersPerProject) } : {}),
            ...(opts.workersPerDomain !== undefined ? { perDomain: Number(opts.workersPerDomain) } : {}),
            ...(opts.workerTimeout !== undefined ? { timeoutSeconds: Number(opts.workerTimeout) } : {}),
            ...(opts.shutdownGrace !== undefined ? { shutdownGraceSeconds: Number(opts.shutdownGrace) } : {}),
          },
          ...(opts.tick ? { tickSeconds: Number(opts.tick) } : {}),
          dispatch: opts.dispatch !== false,
        });
        const shutdown = () => void svc.stop().then(() => process.exit(0));
        process.once('SIGTERM', shutdown);
        process.once('SIGINT', shutdown);
        process.stderr.write(`crewyard service ${svc.workerId} running (pid ${process.pid})\n`);
        await svc.start();
      }),
    );
  withMutationOptions(service.command('start').description('start the service in the background')).action(
    action((ctx, opts) =>
      emit(
        opts,
        startService(ctx, { dryRun: Boolean(opts.dryRun) }),
        (s) => `${s.running ? 'running' : 'not started'} pid=${s.pid ?? '—'} log=${s.logFile}`,
      ),
    ),
  );
  service
    .command('stop')
    .action(
      action(async (ctx, opts) =>
        emit(opts, await stopService(ctx), (r) => (r.stopped ? 'stopped' : 'no service was running')),
      ),
    );
  service.command('status').action(
    action((ctx, opts) =>
      emit(opts, serviceStatus(ctx), (s) =>
        keyValues({
          running: s.running,
          pid: s.pid,
          log: s.logFile,
          workers: s.workers.map((w) => `${w.workerId}@${w.host}:${w.pid}`).join(', '),
          note: s.note,
        }),
      ),
    ),
  );
  withMutationOptions(
    service
      .command('install')
      .description('install a per-user service (systemd user unit, launchd agent or scheduled task)'),
  ).action(
    action(async (ctx, opts) => {
      if (!opts.dryRun) await confirm(opts, 'Install and enable the Crewyard user service?');
      const result = await installServiceUnit(ctx, { dryRun: Boolean(opts.dryRun) });
      emit(opts, result, (r) => [`${r.applied ? 'installed' : '(dry run)'} ${r.file}`, r.content]);
    }),
  );
  withMutationOptions(service.command('uninstall')).action(
    action(async (ctx, opts) => {
      if (!opts.dryRun) await confirm(opts, 'Disable and remove the Crewyard user service?');
      const result = await uninstallServiceUnit(ctx, { dryRun: Boolean(opts.dryRun) });
      emit(opts, result, (r) => `${r.removed ? 'removed' : 'nothing removed'} ${r.file}`);
    }),
  );
}
