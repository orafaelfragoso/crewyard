import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportEvents, follow, listEventPage, metrics, metricsCsv, runDoctor } from '@crewyard/application';
import {
  effectiveConfigView,
  getPath,
  loadConfig,
  REPO_CONFIG_RELATIVE,
  setConfigValue,
  validateConfigText,
} from '@crewyard/config';
import { CrewError, isGitRepository, repositoryRoot } from '@crewyard/core';
import { resolveProject } from '@crewyard/projects';
import type { Command } from 'commander';
import { emit, keyValues, table, writeJson, writeLine } from '../output.ts';
import { action, withMutationOptions } from '../program.ts';

async function repoRootOrNull(): Promise<string | null> {
  return (await isGitRepository(process.cwd())) ? repositoryRoot(process.cwd()) : null;
}

export function registerSystemCommands(program: Command, version: string): void {
  program
    .command('version')
    .description('print version and build information')
    .action(
      action((_ctx, opts) =>
        emit(
          opts,
          { version, bun: Bun.version, platform: process.platform, arch: process.arch },
          (d) => `crew ${d.version} (bun ${d.bun}, ${d.platform}-${d.arch})`,
        ),
      ),
    );

  program
    .command('doctor')
    .description('check runtime, tools, storage, providers, GitHub access and secret store')
    .action(
      action(async (ctx, opts) => {
        const report = await runDoctor(ctx);
        emit(opts, report, (r) => [
          ...r.checks.map(
            (c) =>
              `${c.status.toUpperCase().padEnd(5)} ${c.id.padEnd(24)} ${c.summary}${c.repair ? `\n      repair: ${c.repair}` : ''}`,
          ),
          `overall: ${r.status}`,
        ]);
        if (report.status === 'error') process.exitCode = 5;
      }),
    );

  const config = program.command('config').description('show, validate and edit configuration');
  config
    .command('show')
    .description('show the effective configuration with sources (credentials redacted)')
    .action(
      action(async (ctx, opts) => {
        const loaded = loadConfig({ repoRoot: await repoRootOrNull(), dirs: ctx.dirs });
        const view = effectiveConfigView(loaded);
        emit(opts, { ...view, files: loaded.files, warnings: loaded.warnings }, (d) => [
          `repository config: ${d.files.repository ?? '(none)'}`,
          `user config:       ${d.files.user ?? '(none)'}`,
          ...Object.entries(d.sources)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([path, source]) => `${path.padEnd(48)} ${JSON.stringify(getPath(d.config, path))}  [${source}]`),
          ...d.warnings.map((w) => `warning: ${w.path} ${w.message}`),
        ]);
      }),
    );
  config
    .command('validate [file]')
    .description('validate a configuration file (default: the repository config)')
    .action(
      action(async (_ctx, opts, file?: string) => {
        const root = await repoRootOrNull();
        const target = file ?? (root ? join(root, REPO_CONFIG_RELATIVE) : null);
        if (!target) throw new CrewError('INVALID_INPUT', 'No configuration file given and not inside a repository');
        const issues = validateConfigText(readFileSync(target, 'utf8'));
        const errors = issues.filter((i) => i.severity === 'error');
        emit(opts, { file: target, valid: errors.length === 0, issues }, (d) =>
          d.valid && issues.length === 0
            ? `${d.file}: valid`
            : issues.map((i) => `${i.severity} ${i.path}: ${i.message}`),
        );
        if (errors.length > 0) process.exitCode = 2;
      }),
    );
  withMutationOptions(
    config
      .command('set <path> <value>')
      .description('set a non-secret configuration value')
      .option('--user', 'write to the user configuration instead of the repository configuration'),
  ).action(
    action(async (ctx, opts, path: string, value: string) => {
      const root = await repoRootOrNull();
      const file = opts.user ? join(ctx.dirs.config, 'config.yaml') : root ? join(root, REPO_CONFIG_RELATIVE) : null;
      if (!file)
        throw new CrewError('INVALID_INPUT', 'Not inside a repository; pass --user to edit the user configuration');
      const result = setConfigValue(file, path, value, { dryRun: Boolean(opts.dryRun) });
      emit(opts, result, (r) => `${r.dryRun ? '(dry run) ' : ''}${r.file}\n${r.diff}`);
    }),
  );

  const events = program.command('events').description('inspect the durable event log');
  events
    .command('list')
    .description('list events (newest page by default)')
    .option('--task <id>')
    .option('--type <type...>')
    .option('--before <seq>', 'page older than this sequence', Number)
    .option('--after <seq>', 'page newer than this sequence', Number)
    .option('--limit <n>', 'page size (max 500)', Number, 50)
    .action(
      action(async (ctx, opts) => {
        const project = opts.project ? await resolveProject(ctx, String(opts.project)) : null;
        const page = listEventPage(ctx, {
          ...(project ? { projectId: project.id } : {}),
          ...(opts.task ? { taskId: String(opts.task) } : {}),
          ...(opts.type ? { types: opts.type as string[] } : {}),
          ...(opts.before !== undefined ? { beforeSeq: Number(opts.before) } : {}),
          ...(opts.after !== undefined ? { afterSeq: Number(opts.after), direction: 'newer' as const } : {}),
          limit: Number(opts.limit),
        });
        emit(opts, page, (p) =>
          table(
            p.items.map((e) => ({
              seq: e.seq,
              at: e.at,
              type: e.type,
              actor: `${e.actor.kind}:${e.actor.id}`,
              task: e.taskId,
              payload: e.payload,
            })),
          ),
        );
      }),
    );
  events
    .command('follow')
    .description('stream new events (JSONL with --json); resumes from --after')
    .option('--after <seq>', 'resume after this sequence', Number)
    .option('--task <id>')
    .action(
      action(async (ctx, opts) => {
        const project = opts.project ? await resolveProject(ctx, String(opts.project)) : null;
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        process.once('SIGTERM', () => controller.abort());
        await follow(
          ctx,
          {
            ...(project ? { projectId: project.id } : {}),
            ...(opts.task ? { taskId: String(opts.task) } : {}),
            ...(opts.after !== undefined ? { afterSeq: Number(opts.after) } : {}),
          },
          (e) =>
            opts.json
              ? writeJson(e)
              : writeLine(`${e.seq} ${e.at} ${e.type} ${e.taskId ?? ''} ${JSON.stringify(e.payload)}`),
          controller.signal,
        );
      }),
    );
  events
    .command('export <file>')
    .description('export events as JSONL (secrets are never stored in events)')
    .action(
      action(async (ctx, opts, file: string) => {
        const project = opts.project ? await resolveProject(ctx, String(opts.project)) : null;
        const result = await exportEvents(ctx, file, project ? { projectId: project.id } : {});
        emit(opts, result, (r) => `exported ${r.count} events to ${r.file}`);
      }),
    );

  const metricsCmd = program.command('metrics').description('delivery, efficiency and usage metrics');
  metricsCmd
    .command('show')
    .option('--days <n>', 'window in days', Number, 30)
    .action(
      action(async (ctx, opts) => {
        const project = opts.project ? await resolveProject(ctx, String(opts.project)) : null;
        const report = metrics(ctx, project?.id ?? null, Number(opts.days));
        emit(opts, report, (r) =>
          keyValues({
            window: `${r.window.since} → ${r.window.until}`,
            mergedPrs: r.throughput.mergedPrs,
            leadTimeP50h: r.leadTimeHours.p50.value ?? 'unknown',
            queueWaitP95m: r.queueWaitMinutes.p95.value ?? 'unknown',
            reviewCacheHit: r.reviewCache.hitRatio.value ?? 'unknown',
            ciMinutesPerMerge: r.ciMinutesPerMerge.value ?? 'unknown',
            escalations: r.escalations,
            usage:
              r.usage
                .map(
                  (u) =>
                    `${u.providerId}/${u.model ?? 'default'} in=${u.inputTokens.value ?? 'unknown'} out=${u.outputTokens.value ?? 'unknown'}`,
                )
                .join('; ') || 'none',
          }),
        );
      }),
    );
  metricsCmd
    .command('export <file>')
    .option('--days <n>', 'window in days', Number, 30)
    .option('--format <format>', 'json or csv', 'json')
    .action(
      action(async (ctx, opts, file: string) => {
        const project = opts.project ? await resolveProject(ctx, String(opts.project)) : null;
        const report = metrics(ctx, project?.id ?? null, Number(opts.days));
        await Bun.write(file, opts.format === 'csv' ? metricsCsv(report) : JSON.stringify(report, null, 2));
        emit(opts, { file, format: opts.format }, (d) => `wrote ${d.file}`);
      }),
    );
}
