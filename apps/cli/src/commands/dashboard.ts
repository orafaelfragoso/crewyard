import { createDashboardActions, defaultQueueActions } from '@crewyard/application';
import { resolveProject } from '@crewyard/projects';
import { loadDashboard, renderSnapshot, runDashboard, VIEWS, type ViewName } from '@crewyard/tui';
import type { Command } from 'commander';
import { emit } from '../output.ts';
import { action, operatorActor } from '../program.ts';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('interactive terminal dashboard (prints a static snapshot when not attached to a terminal)')
    .option('--view <view>', `initial view: ${VIEWS.join(', ')}`)
    .option('--snapshot', 'print a static snapshot and exit')
    .action(
      action(async (ctx, opts) => {
        const project = await resolveProject(ctx, opts.project as string | undefined).catch(() => null);
        if (opts.json) return emit(opts, loadDashboard(ctx, project?.id ?? null, true), () => '');
        if (opts.snapshot || !process.stdout.isTTY || !process.stdin.isTTY) {
          process.stdout.write(`${renderSnapshot(ctx, project?.id ?? null, process.stdout.columns ?? 120)}\n`);
          return;
        }
        const view = VIEWS.find((v) => v.toLowerCase() === String(opts.view ?? '').toLowerCase()) as
          | ViewName
          | undefined;
        await runDashboard(ctx, createDashboardActions(ctx, operatorActor(), defaultQueueActions()), {
          projectId: project?.id ?? null,
          ...(view ? { initialView: view } : {}),
        });
      }),
    );
}
