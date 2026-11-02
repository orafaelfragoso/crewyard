import { readFileSync } from 'node:fs';
import {
  buildIndex,
  claimAndPrepare,
  contextPack,
  contextPackPage,
  getSymbol,
  impact,
  indexState,
  initRepository,
  projectForRepositoryPath,
  readinessReport,
  searchContext,
  verifyProjectIndex,
} from '@agent-rail/application';
import { type AutonomyMode, type HandoffKind, RailError, type Risk, type TaskState } from '@agent-rail/core';
import { listProjects, listRepositories, setProjectFlags } from '@agent-rail/projects';
import { explainDispatch } from '@agent-rail/scheduler';
import type { RailContext } from '@agent-rail/storage';
import {
  addTask,
  approvePlan,
  assignAgent,
  cancelGoal,
  createGoal,
  decideTaskApproval,
  forceReleaseLease,
  getNextAction,
  goalStatus,
  heartbeat,
  listGoals,
  listTasks,
  nextTask,
  type PlanProposal,
  type ProposePlanResult,
  proposePlan,
  releaseLease,
  report,
  reportProgress,
  setPriorityOverride,
  setTaskPaused,
  showTask,
  startTask,
  transitionTask,
} from '@agent-rail/tasks';
import { applyCleanup, getWorkspace, inspectWorkspace, listWorkspaces, previewCleanup } from '@agent-rail/workspaces';
import type { Command } from 'commander';
import { confirm, emit, keyValues, table } from '../output.ts';
import { action, operatorActor, withMutationOptions } from '../program.ts';

const list = (value: string, previous: string[] = []) => [
  ...previous,
  ...value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

async function project(ctx: RailContext, opts: { project?: string }) {
  return projectForRepositoryPath(ctx, opts.project);
}

function credentials(taskId: string, opts: Record<string, unknown>) {
  const token = (opts.token as string | undefined) ?? process.env.RAIL_CLAIM_TOKEN;
  const generation = Number(opts.generation ?? process.env.RAIL_LEASE_GENERATION);
  if (!token || !Number.isInteger(generation)) {
    throw new RailError('NOT_AUTHORIZED', 'This command requires the current lease token and generation', {
      suggestion: 'Pass --generation N --token TOKEN (or set RAIL_LEASE_GENERATION and RAIL_CLAIM_TOKEN).',
    });
  }
  return { taskId, generation, token };
}

function leaseOptions(command: Command): Command {
  return command
    .option('--generation <n>', 'lease generation returned by claim (or RAIL_LEASE_GENERATION)')
    .option('--token <token>', 'claim token returned by claim (or RAIL_CLAIM_TOKEN)');
}

function handoffFrom(opts: Record<string, unknown>) {
  const evidence = opts.evidenceFile ? JSON.parse(readFileSync(String(opts.evidenceFile), 'utf8')) : undefined;
  return {
    summary: String(opts.summary ?? ''),
    ...(opts.worktree ? { worktreePath: String(opts.worktree) } : {}),
    ...(opts.commit ? { commits: opts.commit as string[] } : {}),
    ...(evidence ? { testEvidence: evidence } : {}),
    ...(opts.contextPack ? { contextPackIds: opts.contextPack as string[] } : {}),
    ...(opts.issue ? { remainingIssues: opts.issue as string[] } : {}),
  };
}

function handoffOptions(command: Command): Command {
  return command
    .requiredOption('--summary <text>', 'what was done / why it is blocked')
    .option('--worktree <path>')
    .option('--commit <sha>', 'commit id (repeatable)', list)
    .option(
      '--evidence-file <file>',
      'JSON array of test evidence {command, exitCode, durationMs, outputRef?, commitSha}',
    )
    .option('--context-pack <id>', 'context pack id (repeatable)', list)
    .option('--issue <text>', 'remaining issue (repeatable)', (v, p: string[] = []) => [...p, v]);
}

export function registerWorkCommands(program: Command): void {
  program
    .command('init')
    .description('register the repository, write .agent-rail/config.yaml, index and print a readiness report')
    .option('--repo <path>', 'repository path', '.')
    .option('--base <branch>', 'default base branch (detected from origin/HEAD otherwise)')
    .option('--name <name>', 'project name')
    .option('--autonomy <mode>', 'observe | assisted | guarded | autopilot')
    .option('--no-index', 'skip the initial index')
    .action(
      action(async (ctx, opts) => {
        const result = await initRepository(ctx, {
          repoPath: String(opts.repo),
          ...(opts.base ? { baseBranch: String(opts.base) } : {}),
          ...(opts.name ? { name: String(opts.name) } : {}),
          ...(opts.autonomy ? { autonomy: opts.autonomy as AutonomyMode } : {}),
          index: opts.index !== false,
          actor: operatorActor(),
        });
        emit(opts, result, (r) => [
          `${r.created ? 'Registered' : 'Updated'} project ${r.project.name} (${r.project.id}) at ${r.repository.canonicalPath}`,
          `config: ${r.configFile}${r.configCreated ? ' (created)' : ''}`,
          r.index
            ? `index: ${r.index.stats.mode}, ${r.index.stats.indexedFiles} files at ${r.index.snapshot.commitSha.slice(0, 12)}`
            : 'index: skipped',
          '',
          'Readiness:',
          ...r.readiness.map(
            (i) =>
              `  ${i.ok ? '✓' : '✗'} ${i.id.padEnd(8)} ${i.message}${!i.ok && i.action ? `\n             → ${i.action}` : ''}`,
          ),
          '',
          'Next: `rail install --target codex,claude,opencode` to register MCP and Skills with your agent hosts.',
        ]);
      }),
    );

  const projectCmd = program.command('project').description('manage registered projects');
  projectCmd
    .command('add <path>')
    .option('--base <branch>')
    .option('--name <name>')
    .action(
      action(async (ctx, opts, path: string) => {
        const result = await initRepository(ctx, {
          repoPath: path,
          ...(opts.base ? { baseBranch: String(opts.base) } : {}),
          ...(opts.name ? { name: String(opts.name) } : {}),
          index: false,
          actor: operatorActor(),
        });
        emit(opts, result, (r) => `project ${r.project.name} (${r.project.id})`);
      }),
    );
  projectCmd.command('list').action(
    action((ctx, opts) => {
      const rows = listProjects(ctx).map((p) => ({
        ...p,
        repositories: listRepositories(ctx, p.id).map((r) => r.canonicalPath),
      }));
      emit(opts, rows, (r) => table(r, ['id', 'name', 'autonomy', 'intakePaused', 'workersPaused', 'repositories']));
    }),
  );
  projectCmd.command('show').action(
    action(async (ctx, opts) => {
      const { project: p, repository } = await project(ctx, opts);
      const readiness = await readinessReport(ctx, p.id);
      emit(opts, { project: p, repository, readiness }, (d) => [
        keyValues({
          ...d.project,
          repository: d.repository.canonicalPath,
          remote: d.repository.remoteUrl,
          base: d.repository.defaultBase,
        }),
        ...d.readiness.map((i) => `${i.ok ? '✓' : '✗'} ${i.id}: ${i.message}`),
      ]);
    }),
  );
  for (const [name, flags, verb] of [
    ['pause', { intakePaused: true }, 'paused intake for'],
    ['resume', { intakePaused: false, workersPaused: false }, 'resumed'],
  ] as const) {
    withMutationOptions(projectCmd.command(name).option('--workers', 'pause/resume workers instead of intake')).action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const change = opts.workers ? { workersPaused: name === 'pause' } : flags;
        if (opts.dryRun)
          return emit(
            opts,
            { project: p.id, change, dryRun: true },
            () => `(dry run) would set ${JSON.stringify(change)}`,
          );
        const updated = setProjectFlags(ctx, p.id, change, operatorActor());
        emit(opts, updated, (u) => `${verb} ${u.name}`);
      }),
    );
  }

  const index = program.command('index').description('build and inspect the versioned repository index');
  for (const name of ['build', 'update'] as const) {
    index
      .command(name)
      .option('--ref <ref>', 'branch, tag or SHA to index (default: base branch)')
      .option('--worktree <path>', 'index the HEAD of a worktree')
      .option('--force', 'rebuild even if the snapshot exists')
      .action(
        action(async (ctx, opts) => {
          const { project: p } = await project(ctx, opts);
          const ref = opts.ref as string | undefined;
          const result = await buildIndex(ctx, {
            projectId: p.id,
            ...(ref && /^[0-9a-f]{40}$/i.test(ref) ? { sha: ref } : { ref }),
            ...(opts.worktree ? { worktreePath: String(opts.worktree) } : {}),
            force: Boolean(opts.force || name === 'build'),
            actor: operatorActor(),
          });
          emit(opts, result, (r) => keyValues({ commit: r.snapshot.commitSha, status: r.snapshot.status, ...r.stats }));
        }),
      );
  }
  index
    .command('status')
    .option('--ref <ref>')
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const status = await indexState(ctx, { projectId: p.id, ref: opts.ref as string | undefined });
        emit(opts, status, (s) =>
          keyValues({
            status: s.status,
            head: s.headSha,
            snapshot: s.snapshot?.commitSha ?? null,
            suggestion: s.suggestion ?? null,
          }),
        );
      }),
    );
  index
    .command('verify')
    .option('--ref <ref>')
    .option('--sample <n>', 'verify a random sample of blobs', Number)
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const result = await verifyProjectIndex(ctx, {
          projectId: p.id,
          ref: opts.ref as string | undefined,
          ...(opts.sample ? { sample: Number(opts.sample) } : {}),
        });
        emit(opts, result, (r) => JSON.stringify(r, null, 2));
        if (!result.ok) process.exitCode = 5;
      }),
    );

  const context = program.command('context').description('version-aware retrieval with commit provenance');
  const rev = (c: Command) => c.option('--ref <ref>').option('--sha <sha>');
  rev(context.command('search <query>'))
    .option('--mode <mode>', 'fts | exact | regex | path | symbol | hybrid', 'hybrid')
    .option('--path <glob>', 'restrict to paths (repeatable)', list)
    .option('--limit <n>', 'max results', Number, 20)
    .action(
      action(async (ctx, opts, query: string) => {
        const { project: p } = await project(ctx, opts);
        const result = await searchContext(ctx, {
          projectId: p.id,
          query,
          ref: opts.ref as string | undefined,
          sha: opts.sha as string | undefined,
          mode: opts.mode as never,
          limit: Number(opts.limit),
          ...(opts.path ? { paths: opts.path as string[] } : {}),
        });
        emit(opts, result, (r) => [
          `commit ${r.commitSha} · ${r.indexStatus} · retrieved ${r.retrievedAt}`,
          ...r.hits.map(
            (h) =>
              `${h.path}:${h.startLine}-${h.endLine}  (${h.score.toFixed(2)}, ${h.matchKind})\n    ${h.excerpt.split('\n')[0]?.trim() ?? ''}`,
          ),
        ]);
      }),
    );
  rev(context.command('symbol <name>'))
    .option('--path <path>')
    .option('--deps <direction>', 'imports | importedBy | both')
    .action(
      action(async (ctx, opts, name: string) => {
        const { project: p } = await project(ctx, opts);
        const result = await getSymbol(ctx, {
          projectId: p.id,
          name,
          ref: opts.ref as string | undefined,
          sha: opts.sha as string | undefined,
          references: false,
          ...(opts.path ? { path: String(opts.path) } : {}),
          dependencies: (opts.deps as never) ?? null,
        });
        emit(opts, result, (r) =>
          r.definitions.definitions.map(
            (d) =>
              `${d.kind} ${d.name}  ${d.path}:${d.startLine}-${d.endLine}${d.signature ? `\n    ${d.signature}` : ''}`,
          ),
        );
      }),
    );
  rev(context.command('references <name>'))
    .option('--path <path>', 'definition path to disambiguate')
    .action(
      action(async (ctx, opts, name: string) => {
        const { project: p } = await project(ctx, opts);
        const result = await getSymbol(ctx, {
          projectId: p.id,
          name,
          ref: opts.ref as string | undefined,
          sha: opts.sha as string | undefined,
          ...(opts.path ? { path: String(opts.path) } : {}),
        });
        emit(opts, result.references, (r) =>
          r ? r.references.map((x) => `${x.path}:${x.line} [${x.confidence}] ${x.kind}`) : [],
        );
      }),
    );
  rev(context.command('impact'))
    .option('--path <path>', 'changed path (repeatable)', list)
    .option('--symbol <name>', 'changed symbol (repeatable)', list)
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const result = await impact(ctx, {
          projectId: p.id,
          ref: opts.ref as string | undefined,
          sha: opts.sha as string | undefined,
          ...(opts.path ? { paths: opts.path as string[] } : {}),
          ...(opts.symbol ? { symbols: opts.symbol as string[] } : {}),
        });
        emit(opts, result, (r) => [
          `commit ${r.commitSha}`,
          `modules:    ${r.modules.map((m) => `${m.module} [${m.tier}]`).join(', ') || '—'}`,
          `dependents: ${r.dependents.map((d) => `${d.path} [${d.tier}]`).join(', ') || '—'}`,
          `tests:      ${r.relatedTests.map((t) => `${t.path} [${t.tier}]`).join(', ') || '—'}`,
          `leased:     ${r.leasedScopes.map((l) => `${l.taskId}:${l.scope}`).join(', ') || '—'}`,
          `open PRs:   ${r.openPullRequests.map((o) => `#${o.number}`).join(', ') || '—'}`,
          r.disclaimer,
        ]);
      }),
    );
  rev(context.command('pack [query]'))
    .option('--path <path>', 'scope path (repeatable)', list)
    .option('--symbol <name>', 'scope symbol (repeatable)', list)
    .option('--budget <tokens>', 'token budget', Number)
    .option('--cursor <cursor>', 'fetch the next page of a previous pack')
    .action(
      action(async (ctx, opts, query?: string) => {
        if (opts.cursor) {
          const page = await contextPackPage(ctx, String(opts.cursor), opts.budget ? Number(opts.budget) : undefined);
          return emit(opts, page, (r) => JSON.stringify(r, null, 2));
        }
        if (!query) throw new RailError('INVALID_INPUT', 'A query is required unless --cursor is given');
        const { project: p } = await project(ctx, opts);
        const pack = await contextPack(ctx, {
          projectId: p.id,
          query,
          ref: opts.ref as string | undefined,
          sha: opts.sha as string | undefined,
          ...(opts.path ? { paths: opts.path as string[] } : {}),
          ...(opts.symbol ? { symbols: opts.symbol as string[] } : {}),
          ...(opts.budget ? { budgetTokens: Number(opts.budget) } : {}),
        });
        emit(opts, pack, (r) => [
          `pack ${r.packId} · commit ${r.commitSha} · ~${r.tokenEstimate} tokens${r.nextCursor ? ` · next: --cursor ${r.nextCursor}` : ''}`,
          ...r.warnings.map((w) => `warning: ${w}`),
          ...r.excerpts.map((e) => `\n## ${e.path}:${e.startLine}-${e.endLine} — ${e.reasons.join('; ')}\n${e.text}`),
        ]);
      }),
    );

  const goal = program.command('goal').description('goals and validated task plans');
  goal
    .command('create')
    .requiredOption('--title <title>')
    .option('--description <text>')
    .option('--description-file <file>')
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const description = opts.descriptionFile
          ? readFileSync(String(opts.descriptionFile), 'utf8')
          : ((opts.description as string | undefined) ?? '');
        const created = createGoal(ctx, {
          projectId: p.id,
          title: String(opts.title),
          description,
          actor: operatorActor(),
        });
        emit(opts, created, (g) => `${g.id} created: ${g.title}`);
      }),
    );
  goal
    .command('plan <goalId>')
    .description('submit a task plan (--file plan.json|yaml) or ask a planning agent (--agent NAME)')
    .option(
      '--file <file>',
      'plan with {summary?, tasks:[{key,title,objective,acceptanceCriteria,dependencies,scopeHints,risk,...}]}',
    )
    .option('--agent <name>', 'planning agent')
    .action(
      action(async (ctx, opts, goalId: string) => {
        if (opts.agent) {
          const { planGoalWithAgent } = await import('@agent-rail/application');
          const result = await planGoalWithAgent(ctx, { goalId, agent: String(opts.agent), actor: operatorActor() });
          return emit(opts, result, (r) => planSummary(r));
        }
        if (!opts.file) throw new RailError('INVALID_INPUT', 'Pass --file PLAN or --agent NAME');
        const text = readFileSync(String(opts.file), 'utf8');
        const plan = (String(opts.file).match(/\.ya?ml$/) ? Bun.YAML.parse(text) : JSON.parse(text)) as PlanProposal;
        const result = proposePlan(ctx, goalId, { plan, source: 'human', actor: operatorActor() });
        emit(opts, result, (r) => planSummary(r));
        if (!result.validation.valid) process.exitCode = 2;
      }),
    );
  withMutationOptions(goal.command('approve <goalId>')).action(
    action(async (ctx, opts, goalId: string) => {
      await confirm(opts, `Approve the plan for ${goalId} and create its tasks?`);
      const result = approvePlan(ctx, goalId, operatorActor());
      emit(opts, result, (r) => JSON.stringify(r, null, 2));
    }),
  );
  goal.command('status [goalId]').action(
    action(async (ctx, opts, goalId?: string) => {
      if (goalId) return emit(opts, goalStatus(ctx, goalId), (s) => JSON.stringify(s, null, 2));
      const { project: p } = await project(ctx, opts);
      emit(opts, listGoals(ctx, { projectId: p.id }), (g) =>
        table(g as unknown as Record<string, unknown>[], ['id', 'title', 'state', 'updatedAt']),
      );
    }),
  );
  withMutationOptions(goal.command('cancel <goalId>').requiredOption('--reason <text>')).action(
    action(async (ctx, opts, goalId: string) => {
      await confirm(opts, `Cancel ${goalId} and all of its active tasks?`);
      emit(opts, cancelGoal(ctx, goalId, { actor: operatorActor(), reason: String(opts.reason) }), (r) =>
        JSON.stringify(r, null, 2),
      );
    }),
  );

  const task = program.command('task').description('tasks, leases and handoffs');
  task
    .command('add')
    .requiredOption('--title <title>')
    .option('--objective <text>')
    .option('--criteria <text>', 'acceptance criterion (repeatable)', (v, p: string[] = []) => [...p, v])
    .option('--depends-on <ids>', 'dependency task ids', list)
    .option('--scope <paths>', 'scope hints (paths/globs or resource:name)', list)
    .option('--exclusive <resources>', 'exclusive resources', list)
    .option('--risk <risk>', 'low | medium | high', 'medium')
    .option('--priority <n>', '0-100', Number, 50)
    .option('--role <role>', 'requested agent role')
    .option('--goal <goalId>')
    .option('--ready', 'mark READY immediately (default: DRAFT)')
    .action(
      action(async (ctx, opts) => {
        const { project: p, repository } = await project(ctx, opts);
        const created = addTask(ctx, {
          projectId: p.id,
          title: String(opts.title),
          repositoryId: repository.id,
          ...(opts.objective ? { objective: String(opts.objective) } : {}),
          ...(opts.criteria ? { acceptanceCriteria: opts.criteria as string[] } : {}),
          ...(opts.dependsOn ? { dependencies: opts.dependsOn as string[] } : {}),
          ...(opts.scope ? { scopeHints: opts.scope as string[] } : {}),
          ...(opts.exclusive ? { exclusiveResources: opts.exclusive as string[] } : {}),
          risk: opts.risk as Risk,
          priority: Number(opts.priority),
          ...(opts.role ? { requestedRole: String(opts.role) } : {}),
          ...(opts.goal ? { goalId: String(opts.goal) } : {}),
          ...(opts.ready ? { initialState: 'READY' as const } : {}),
          origin: 'manual',
          actor: operatorActor(),
        });
        emit(opts, created, (t) => `${t.id} ${t.state}: ${t.title}`);
      }),
    );
  task
    .command('list')
    .option('--state <states>', 'filter by states', list)
    .option('--goal <goalId>')
    .option('--dispatchable', 'only tasks that can be claimed now')
    .option('--limit <n>', 'page size', Number, 100)
    .option('--cursor <cursor>')
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const page = listTasks(ctx, {
          projectId: p.id,
          ...(opts.state ? { states: opts.state as TaskState[] } : {}),
          ...(opts.goal ? { goalId: String(opts.goal) } : {}),
          ...(opts.dispatchable ? { dispatchable: true } : {}),
          limit: Number(opts.limit),
          cursor: (opts.cursor as string | undefined) ?? null,
        });
        emit(opts, page, (pg) =>
          table(
            pg.items.map((t) => ({
              id: t.id,
              state: t.state,
              priority: t.effectivePriority ?? t.priority,
              risk: t.risk,
              title: t.title,
              deps: t.dependencies,
            })),
          ),
        );
      }),
    );
  task
    .command('show <taskId>')
    .action(
      action((ctx, opts, taskId: string) => emit(opts, showTask(ctx, taskId), (d) => JSON.stringify(d, null, 2))),
    );
  task
    .command('next')
    .requiredOption('--agent <id>', 'agent id or name')
    .action(
      action(async (ctx, opts) => {
        const { project: p } = await project(ctx, opts);
        const suggestion = nextTask(ctx, String(opts.agent), { projectId: p.id });
        const action = getNextAction(ctx, { agentId: String(opts.agent), projectId: p.id });
        emit(opts, { suggestion, action }, (d) =>
          d.suggestion
            ? `${d.suggestion.task.id}: ${d.suggestion.task.title} (${d.suggestion.reason})`
            : `nothing to do: ${JSON.stringify(d.action)}`,
        );
      }),
    );
  task
    .command('explain <taskId>')
    .description('explain exactly why a task was or was not dispatched')
    .action(
      action((ctx, opts, taskId: string) =>
        emit(opts, explainDispatch(ctx, taskId), (e) => JSON.stringify(e, null, 2)),
      ),
    );
  task
    .command('claim <taskId>')
    .requiredOption('--agent <id>', 'claiming agent id')
    .option('--no-workspace', 'do not allocate a worktree')
    .action(
      action(async (ctx, opts, taskId: string) => {
        const claim = await claimAndPrepare(ctx, {
          taskId,
          holder: { kind: 'agent', id: String(opts.agent) },
          actor: { kind: 'agent', id: String(opts.agent) },
          allocateWorkspace: opts.workspace !== false,
        });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: claim })}\n`);
          return;
        }
        process.stdout.write(
          `${keyValues({ ...claim, reservations: claim.reservations.map((r) => `${r.mode}:${r.scope}`).join(', ') })}\n` +
            `export RAIL_LEASE_GENERATION=${claim.leaseGeneration} RAIL_CLAIM_TOKEN=${claim.claimToken}\n`,
        );
      }),
    );
  leaseOptions(task.command('heartbeat <taskId>')).action(
    action((ctx, opts, taskId: string) =>
      emit(opts, heartbeat(ctx, credentials(taskId, opts)), (h) => `lease renewed until ${h.expiresAt}`),
    ),
  );
  leaseOptions(task.command('start <taskId>')).action(
    action((ctx, opts, taskId: string) =>
      emit(opts, startTask(ctx, credentials(taskId, opts)), (t) => `${t.id} ${t.state}`),
    ),
  );
  leaseOptions(task.command('release <taskId>').option('--reason <text>')).action(
    action((ctx, opts, taskId: string) =>
      emit(
        opts,
        releaseLease(ctx, { ...credentials(taskId, opts), ...(opts.reason ? { reason: String(opts.reason) } : {}) }),
        (r) => `${r.task.id} ${r.from} → ${r.to}`,
      ),
    ),
  );
  leaseOptions(
    task
      .command('report <taskId>')
      .description('store a progress checkpoint')
      .requiredOption('--summary <text>')
      .option('--percent <n>', 'progress percent', Number)
      .option('--commit <sha>', 'commit (repeatable)', list),
  ).action(
    action((ctx, opts, taskId: string) =>
      emit(
        opts,
        reportProgress(ctx, {
          ...credentials(taskId, opts),
          summary: String(opts.summary),
          ...(opts.percent !== undefined ? { percent: Number(opts.percent) } : {}),
          ...(opts.commit ? { commits: opts.commit as string[] } : {}),
        }),
        (r) => `checkpoint stored; lease until ${r.expiresAt}`,
      ),
    ),
  );
  for (const [name, kind, description] of [
    ['complete', 'completed', 'hand off finished work'],
    ['block', 'blocked', 'report a blocker and release resources'],
    ['submit', 'ready_for_pr', 'hand off work that is ready for a PR'],
  ] as const) {
    leaseOptions(
      handoffOptions(task.command(`${name} <taskId>`).description(description)).option(
        '--kind <kind>',
        'blocked | needs_review | ready_for_pr | completed',
        kind,
      ),
    ).action(
      action((ctx, opts, taskId: string) =>
        emit(
          opts,
          report(ctx, { ...credentials(taskId, opts), kind: opts.kind as HandoffKind, handoff: handoffFrom(opts) }),
          (r) => `${r.taskId}: ${r.transitions.map((t) => `${t.from} → ${t.to}`).join(', ')}`,
        ),
      ),
    );
  }
  withMutationOptions(task.command('retry <taskId>').requiredOption('--reason <text>')).action(
    action(async (ctx, opts, taskId: string) => {
      const detail = showTask(ctx, taskId);
      const to: TaskState = detail.task.state === 'ESCALATED' || detail.task.state === 'BLOCKED' ? 'READY' : 'READY';
      if (detail.lease) {
        await confirm(opts, `${taskId} holds an active lease; force-release it?`);
        return emit(
          opts,
          forceReleaseLease(ctx, taskId, { reason: String(opts.reason), actor: operatorActor(), to: 'READY' }),
          (r) => `${r.from} → ${r.to}`,
        );
      }
      emit(
        opts,
        transitionTask(ctx, { taskId, to, actor: operatorActor(), reason: String(opts.reason) }),
        (r) => `${r.from} → ${r.to}`,
      );
    }),
  );
  task
    .command('escalate <taskId>')
    .requiredOption('--reason <text>')
    .action(
      action((ctx, opts, taskId: string) =>
        emit(
          opts,
          transitionTask(ctx, {
            taskId,
            to: 'ESCALATED',
            actor: operatorActor(),
            reason: String(opts.reason),
            blockerReason: String(opts.reason),
          }),
          (r) => `${r.from} → ${r.to}`,
        ),
      ),
    );
  task
    .command('ready <taskId>')
    .description('move a DRAFT task to READY')
    .action(
      action((ctx, opts, taskId: string) =>
        emit(opts, transitionTask(ctx, { taskId, to: 'READY', actor: operatorActor() }), (r) => `${r.from} → ${r.to}`),
      ),
    );
  withMutationOptions(task.command('cancel <taskId>').requiredOption('--reason <text>')).action(
    action(async (ctx, opts, taskId: string) => {
      await confirm(opts, `Cancel ${taskId}?`);
      const state = showTask(ctx, taskId).task.state;
      const to: TaskState =
        state === 'DRAFT' || state === 'READY' || state === 'ESCALATED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      emit(
        opts,
        transitionTask(ctx, { taskId, to, actor: operatorActor(), reason: String(opts.reason) }),
        (r) => `${r.from} → ${r.to}`,
      );
    }),
  );
  task
    .command('priority <taskId> <priority>')
    .description('operator priority override (use "clear" to remove)')
    .action(
      action((ctx, opts, taskId: string, priority: string) =>
        emit(
          opts,
          setPriorityOverride(ctx, taskId, priority === 'clear' ? null : Number(priority), operatorActor()),
          (t) => `${t.id} priority ${priority}`,
        ),
      ),
    );
  for (const [name, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    task
      .command(`${name} <taskId>`)
      .action(
        action((ctx, opts, taskId: string) =>
          emit(
            opts,
            setTaskPaused(ctx, taskId, paused, operatorActor()),
            (t) => `${t.id} ${paused ? 'paused' : 'resumed'}`,
          ),
        ),
      );
  }
  task
    .command('assign <taskId> [agentId]')
    .description('assign (or with no agent, unassign) a task')
    .action(
      action((ctx, opts, taskId: string, agentId?: string) =>
        emit(
          opts,
          assignAgent(ctx, taskId, agentId ?? null, operatorActor()),
          (t) => `${t.id} → ${agentId ?? 'unassigned'}`,
        ),
      ),
    );
  withMutationOptions(task.command('approve <taskId>').option('--reject', 'reject instead of approve')).action(
    action(async (ctx, opts, taskId: string) => {
      await confirm(opts, `${opts.reject ? 'Reject' : 'Approve'} the risk gate for ${taskId}?`);
      emit(opts, decideTaskApproval(ctx, taskId, opts.reject ? 'rejected' : 'approved', operatorActor()), (a) =>
        JSON.stringify(a, null, 2),
      );
    }),
  );

  const workspace = program.command('workspace').description('isolated per-task Git worktrees');
  workspace
    .command('create <taskId>')
    .description('allocate a worktree for a task you already hold a lease on (normally done by claim)')
    .action(
      action(async (ctx, opts, taskId: string) => {
        const { allocateWorkspace } = await import('@agent-rail/workspaces');
        const result = await allocateWorkspace(ctx, { taskId, actor: operatorActor() });
        emit(
          opts,
          result,
          (r) => `${r.workspace.id} ${r.workspace.path} (${r.workspace.branch})${r.reused ? ' [reused]' : ''}`,
        );
      }),
    );
  workspace.command('list').action(
    action(async (ctx, opts) => {
      const { repository } = await project(ctx, opts);
      emit(opts, listWorkspaces(ctx, { repositoryId: repository.id }), (w) =>
        table(w as unknown as Record<string, unknown>[], ['id', 'taskId', 'state', 'branch', 'path']),
      );
    }),
  );
  workspace.command('inspect <workspaceId>').action(
    action(async (ctx, opts, workspaceId: string) => {
      const inspection = await inspectWorkspace(ctx, workspaceId);
      emit(opts, { workspace: getWorkspace(ctx, workspaceId), inspection }, (d) => JSON.stringify(d, null, 2));
    }),
  );
  withMutationOptions(
    workspace
      .command('clean')
      .description('preview, then remove abandoned worktrees (backups are saved first)')
      .option('--authorize-dirty <reason>', 'also remove worktrees with uncommitted/unpushed work (backups are kept)'),
  ).action(
    action(async (ctx, opts) => {
      const { repository } = await project(ctx, opts);
      const preview = await previewCleanup(ctx, { repositoryId: repository.id });
      if (opts.dryRun || preview.items.length === 0) {
        return emit(opts, { preview, applied: false }, (d) =>
          d.preview.items.length ? table(d.preview.items as unknown as Record<string, unknown>[]) : 'nothing to clean',
        );
      }
      emit(opts, preview, (pv) => table(pv.items as unknown as Record<string, unknown>[]));
      await confirm(opts, `Remove ${preview.items.length} workspace(s)? Backups are written first.`);
      const result = await applyCleanup(ctx, {
        previewFingerprint: preview.fingerprint,
        actor: operatorActor(),
        repositoryId: repository.id,
        ...(opts.authorizeDirty
          ? { authorization: { reason: String(opts.authorizeDirty), approvedBy: operatorActor() } }
          : {}),
      });
      emit(opts, result, (r) => JSON.stringify(r, null, 2));
    }),
  );
}

function planSummary(r: ProposePlanResult) {
  return [
    `${r.goal.id}: ${r.goal.state}${r.validation.valid ? '' : ' (plan rejected by validation)'}`,
    ...r.validation.issues.map((i) => `  ${i.code}${i.taskKey ? ` [${i.taskKey}]` : ''}: ${i.message}`),
    ...(r.tasks.length ? [`created ${r.tasks.map((t) => t.id).join(', ')}`] : []),
    ...(r.validation.valid && r.approval?.status === 'pending' ? [`approve with: rail goal approve ${r.goal.id}`] : []),
  ];
}
