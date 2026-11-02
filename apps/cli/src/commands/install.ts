import { join } from 'node:path';
import { railInvocation } from '@agent-rail/application';
import { isGitRepository, RailError, repositoryRoot } from '@agent-rail/core';
import {
  applyPlan,
  applyUninstall,
  bundledSkillsDir,
  detectHosts,
  type HostId,
  type InstallPlan,
  materializeSkills,
  planInstall,
  planUninstall,
} from '@agent-rail/host-installers';
import type { RailContext } from '@agent-rail/storage';
import type { Command } from 'commander';
import { confirm, emit, table } from '../output.ts';
import { action, withMutationOptions } from '../program.ts';

const HOSTS: readonly HostId[] = ['codex', 'claude', 'opencode'];

function parseTargets(value: string | undefined): HostId[] {
  const targets = (value ?? HOSTS.join(',')).split(',').map((s) => s.trim()) as HostId[];
  const unknown = targets.filter((t) => !HOSTS.includes(t));
  if (unknown.length > 0)
    throw new RailError('INVALID_INPUT', `Unknown target(s): ${unknown.join(', ')}`, {
      suggestion: `Supported: ${HOSTS.join(', ')}`,
    });
  return targets;
}

async function common(ctx: RailContext, opts: Record<string, unknown>) {
  const scope = opts.scope === 'project' ? ('project' as const) : ('user' as const);
  let projectRoot: string | undefined;
  if (scope === 'project' || opts.instructions) {
    if (!(await isGitRepository(process.cwd())))
      throw new RailError('INVALID_INPUT', 'Project scope requires running inside a repository');
    projectRoot = await repositoryRoot(process.cwd());
  }
  const skillsSourceDir = bundledSkillsDir() ?? materializeSkills(join(ctx.dirs.data, 'skills', 'bundled'));
  return {
    targets: parseTargets(opts.target as string | undefined),
    scope,
    ...(projectRoot ? { projectRoot } : {}),
    skillsSourceDir,
    includeInstructions: Boolean(opts.instructions),
    ...(Bun.which('rail') ? {} : { railCommand: railInvocation() }),
    dirs: ctx.dirs,
  };
}

function render(plan: InstallPlan, applied: boolean): string[] {
  return [
    ...plan.changes.map((c) =>
      c.kind === 'file'
        ? `${c.action.toUpperCase()} ${c.path} [${c.purpose}]\n${c.preview}`
        : `RUN ${c.commands.map((x) => x.join(' ')).join(' && ')}`,
    ),
    ...plan.manualInstructions.map(
      (m) =>
        `MANUAL (${m.host}, ${m.purpose}): ${m.reason}${m.path ? `\n  file: ${m.path}` : ''}${m.snippet ? `\n${m.snippet}` : ''}${m.command ? `\n  $ ${m.command}` : ''}`,
    ),
    ...plan.notes.map((n) => `note: ${n}`),
    plan.changes.length === 0
      ? 'Nothing to change.'
      : applied
        ? 'Applied. Backups and a manifest were written before any file changed.'
        : '(dry run: nothing was written)',
  ];
}

export function registerInstallCommands(program: Command): void {
  for (const kind of ['install', 'uninstall'] as const) {
    withMutationOptions(
      program
        .command(kind)
        .description(
          kind === 'install'
            ? 'register the Rail MCP server and Skills with agent hosts'
            : 'remove only Rail-owned host configuration and restore backups',
        )
        .option('--target <hosts>', 'codex,claude,opencode (default: all)')
        .option('--scope <scope>', 'user | project', 'user')
        .option('--instructions', 'add/remove the bootstrap block in AGENTS.md / CLAUDE.md of this repository'),
    ).action(
      action(async (ctx, opts) => {
        const options = await common(ctx, opts);
        const plan = kind === 'install' ? await planInstall(options) : await planUninstall(options);
        if (opts.dryRun || plan.changes.length === 0)
          return emit(opts, { plan, applied: false }, (d) => render(d.plan, false));
        if (!opts.json) for (const line of render(plan, false).slice(0, -1)) process.stderr.write(`${line}\n`);
        await confirm(opts, `${kind === 'install' ? 'Apply' : 'Remove'} ${plan.changes.length} change(s)?`);
        const result =
          kind === 'install'
            ? await applyPlan(plan, { dirs: ctx.dirs })
            : await applyUninstall(plan, { dirs: ctx.dirs });
        emit(opts, { plan, result, applied: true }, (d) => [
          ...render(d.plan, true).slice(-1),
          `backup: ${d.result.backupDir ?? '—'}`,
        ]);
      }),
    );
  }
  program
    .command('hosts')
    .description('detect supported agent hosts and their Rail registration')
    .action(
      action(async (ctx, opts) => {
        const hosts = await detectHosts({ dirs: ctx.dirs });
        emit(opts, hosts, (rows) =>
          table(
            rows.map((h) => ({
              host: h.host,
              installed: h.installed,
              version: h.version,
              support: h.support,
              userRegistered: h.registered.user,
              notes: h.notes.join('; '),
            })),
          ),
        );
      }),
    );
}
