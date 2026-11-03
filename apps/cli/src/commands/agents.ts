import { createInterface } from 'node:readline/promises';
import {
  type AccountPolicyView,
  addProfile,
  assignAgentToTeam,
  createAccountPolicy,
  createAgent,
  createTeam,
  getAccountPolicy,
  getAgent,
  getProfile,
  listAccountPolicies,
  listAgents,
  listProfiles,
  listSessions,
  listTeams,
  loginProfile,
  readSessionLog,
  registerUnmanagedAgent,
  removeAccountPolicy,
  removeAgent,
  removeProfile,
  stopSession,
  testProfile,
  updateAccountPolicy,
  updateAgent,
} from '@crewyard/agents';
import { dispatchTask } from '@crewyard/application';
import { type AuthMechanism, CrewError, type ProviderId } from '@crewyard/core';
import { listProjects, resolveProject } from '@crewyard/projects';
import type { Command } from 'commander';
import { confirm, emit, keyValues, table } from '../output.ts';
import { action, operatorActor, withMutationOptions } from '../program.ts';
import { watchSession } from '../session-progress.ts';

const list = (value: string, previous: string[] = []) => [
  ...previous,
  ...value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

async function readSecret(opts: Record<string, unknown>): Promise<string | undefined> {
  if (opts.apiKeyEnv) {
    const value = process.env[String(opts.apiKeyEnv)];
    if (!value) throw new CrewError('INVALID_INPUT', `Environment variable ${String(opts.apiKeyEnv)} is empty`);
    return value;
  }
  if (!opts.apiKeyStdin) return undefined;
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const muted = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stderr.write('API key (input hidden): ');
    muted._writeToOutput = () => {};
    const value = (await rl.question('')).trim();
    rl.close();
    process.stderr.write('\n');
    return value;
  }
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

export function registerAgentCommands(program: Command): void {
  const account = program
    .command('account')
    .description('provider account profiles (credentials live in the OS secret store)');
  account
    .command('add')
    .requiredOption('--provider <provider>', 'codex | claude | opencode | generic | ollama')
    .requiredOption('--name <name>', 'profile name, unique per provider')
    .option('--display-name <name>')
    .option('--auth <mechanism>', 'cli-login | api-key | local | none')
    .option('--api-key-stdin', 'read an API key from stdin (hidden prompt on a TTY)')
    .option('--api-key-env <var>', 'read an API key once from this environment variable')
    .option('--config-root <dir>', 'provider configuration directory for this profile (documented isolation)')
    .option('--use-default-config', "use the provider's default configuration directory (single profile only)")
    .option('--models <models>', 'permitted models', list)
    .option('--concurrency <n>', 'max concurrent sessions', Number)
    .option('--command <cmd...>', 'generic provider: executable and arguments')
    .option('--endpoint <url>', 'ollama endpoint')
    .action(
      action(async (ctx, opts) => {
        const apiKey = await readSecret(opts);
        const settings: Record<string, unknown> = {
          ...(opts.command
            ? { command: (opts.command as string[])[0], args: (opts.command as string[]).slice(1), codingAgent: true }
            : {}),
          ...(opts.endpoint ? { endpoint: String(opts.endpoint) } : {}),
        };
        const profile = await addProfile(ctx, {
          providerId: opts.provider as ProviderId,
          name: String(opts.name),
          ...(opts.displayName ? { displayName: String(opts.displayName) } : {}),
          ...(opts.auth
            ? { authMechanism: opts.auth as AuthMechanism }
            : apiKey
              ? { authMechanism: 'api-key' as const }
              : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(opts.configRoot ? { configRoot: String(opts.configRoot) } : {}),
          ...(opts.useDefaultConfig ? { useProviderDefaultConfig: true } : {}),
          ...(opts.models ? { permittedModels: opts.models as string[] } : {}),
          ...(opts.concurrency ? { maxConcurrency: Number(opts.concurrency) } : {}),
          ...(Object.keys(settings).length ? { settings } : {}),
          actor: operatorActor(),
        });
        emit(opts, profile, (p) => {
          const summary = `${p.ref} (${p.id}) auth=${p.authMechanism}${p.configRoot ? ` config=${p.configRoot}` : ''}`;
          const next =
            p.authMechanism === 'cli-login' && p.configRoot
              ? `crew account login ${p.ref}`
              : `crew account test ${p.ref}`;
          return `${summary}\nNext: ${next}`;
        });
      }),
    );
  account
    .command('login <ref>')
    .description("log a cli-login profile in through the provider's own CLI, in the profile's configuration directory")
    .action(
      action(async (ctx, opts, ref: string) => {
        const result = await loginProfile(ctx, ref);
        emit(opts, result, (r) => `${r.profile.ref}: ${r.health.status} (${r.health.detail})`);
        if (result.health.status !== 'healthy') process.exitCode = result.health.status === 'unauthenticated' ? 4 : 5;
      }),
    );
  account
    .command('list')
    .option('--provider <provider>')
    .action(
      action((ctx, opts) =>
        emit(opts, listProfiles(ctx, opts.provider ? { providerId: opts.provider as ProviderId } : {}), (rows) =>
          table(rows as unknown as Record<string, unknown>[], [
            'id',
            'providerId',
            'name',
            'authMechanism',
            'maxConcurrency',
            'permittedModels',
          ]),
        ),
      ),
    );
  account
    .command('show <ref>')
    .action(
      action((ctx, opts, ref: string) =>
        emit(opts, getProfile(ctx, ref), (p) => keyValues(p as unknown as Record<string, unknown>)),
      ),
    );
  account
    .command('test <ref>')
    .description('check CLI availability, authentication status and capabilities')
    .action(
      action(async (ctx, opts, ref: string) => {
        const result = await testProfile(ctx, ref);
        emit(opts, result, (r) => JSON.stringify(r, null, 2));
        if (result.health.status !== 'healthy') process.exitCode = result.health.status === 'unauthenticated' ? 4 : 5;
      }),
    );
  withMutationOptions(
    account.command('remove <ref>').option('--purge-config-root', 'also delete the profile configuration directory'),
  ).action(
    action(async (ctx, opts, ref: string) => {
      if (!opts.dryRun) await confirm(opts, `Remove account ${ref} and its stored credential?`);
      const removed = await removeProfile(ctx, ref, {
        purgeConfigRoot: Boolean(opts.purgeConfigRoot),
        dryRun: Boolean(opts.dryRun),
        actor: operatorActor(),
      });
      emit(opts, removed, (r) => [
        `${r.dryRun ? 'would remove' : 'removed'} ${r.ref}`,
        ...(r.removedFromPolicies.length ? [`  dropped from policies: ${r.removedFromPolicies.join(', ')}`] : []),
        ...(r.configRootPurged
          ? [r.dryRun ? '  would delete the configuration directory' : '  configuration directory deleted']
          : []),
      ]);
    }),
  );

  const policy = account
    .command('policy')
    .description('account policies: which accounts an agent may use, in order of preference');
  const policyLine = (p: AccountPolicyView) =>
    `${p.name}: ${p.profiles.join(' → ') || '(no accounts)'}${p.allowFallback ? ' (fallback on)' : ''}${
      p.models.length ? ` models=${p.models.join(',')}` : ''
    }${p.agents.length ? ` used by ${p.agents.join(', ')}` : ' (unused)'}`;
  policy
    .command('create <name>')
    .description('create a policy from accounts in order of preference')
    .requiredOption('--accounts <refs>', 'accounts in order of preference, e.g. claude/work,claude/work-2', list)
    .option('--allow-fallback', 'move to the next account when one is rate limited or logged out')
    .option('--models <models>', 'models agents may use with these accounts', list)
    .action(
      action((ctx, opts, name: string) =>
        emit(
          opts,
          createAccountPolicy(ctx, {
            name,
            profiles: opts.accounts as string[],
            allowFallback: Boolean(opts.allowFallback),
            ...(opts.models ? { models: opts.models as string[] } : {}),
            actor: operatorActor(),
          }),
          policyLine,
        ),
      ),
    );
  policy.command('list').action(
    action((ctx, opts) =>
      emit(opts, listAccountPolicies(ctx), (rows) =>
        table(
          rows.map((p) => ({
            name: p.name,
            accounts: p.profiles.join(' → '),
            fallback: p.allowFallback,
            models: p.models.join(','),
            agents: p.agents.join(','),
          })),
        ),
      ),
    ),
  );
  policy
    .command('show <policy>')
    .action(action((ctx, opts, ref: string) => emit(opts, getAccountPolicy(ctx, ref), policyLine)));
  policy
    .command('update <policy>')
    .description('change the accounts, fallback or models of a policy; agents using it pick it up on their next task')
    .option('--accounts <refs>', 'replace the accounts, in order of preference', list)
    .option('--allow-fallback', 'move to the next account when one is rate limited or logged out')
    .option('--no-allow-fallback', 'only ever use the first account')
    .option('--models <models>', 'replace the model allowlist (empty string clears it)', list)
    .action(
      action((ctx, opts, ref: string) =>
        emit(
          opts,
          updateAccountPolicy(ctx, ref, {
            ...(opts.accounts ? { profiles: opts.accounts as string[] } : {}),
            ...(opts.allowFallback !== undefined ? { allowFallback: Boolean(opts.allowFallback) } : {}),
            ...(opts.models ? { models: opts.models as string[] } : {}),
            actor: operatorActor(),
          }),
          policyLine,
        ),
      ),
    );
  withMutationOptions(policy.command('remove <policy>').description('remove a policy that no agent uses')).action(
    action(async (ctx, opts, ref: string) => {
      if (!opts.dryRun) await confirm(opts, `Remove account policy ${ref}?`);
      const removed = removeAccountPolicy(ctx, ref, { dryRun: Boolean(opts.dryRun), actor: operatorActor() });
      emit(opts, removed, (p) => `${opts.dryRun ? 'would remove' : 'removed'} policy ${p.name}`);
    }),
  );

  const agent = program.command('agent').description('reusable agent definitions and managed sessions');
  agent
    .command('create')
    .requiredOption('--name <name>')
    .option('--role <role>', 'engineer | architect | reviewer | ...', 'engineer')
    .option('--provider <provider>', 'preferred provider')
    .option('--model <model>', 'preferred model')
    .option('--account <ref>', 'the account this agent uses, e.g. claude/personal')
    .option('--policy <name>', 'an account policy, to use several accounts in order')
    .option('--instructions <text>', 'system instructions')
    .option('--skills <names>', 'skills', list)
    .option('--tools <names>', 'allowed MCP tools (default: all agent tools)', list)
    .option('--review-authority <level>', 'none | advisory | required')
    .option('--max-parallel <n>', 'max concurrent sessions', Number)
    .option('--unmanaged', 'register an external agent that Crewyard does not launch')
    .action(
      action(async (ctx, opts) => {
        const project = opts.project
          ? await resolveProject(ctx, String(opts.project))
          : await resolveProject(ctx, undefined).catch(() => null);
        if (opts.unmanaged) {
          const created = registerUnmanagedAgent(ctx, {
            name: String(opts.name),
            allowedTools: (opts.tools as string[] | undefined) ?? [],
            ...(project ? { projects: [project.id] } : {}),
          });
          return emit(opts, created, (a) => [
            `${a.name} (${a.id}) unmanaged`,
            ...a.limitations.map((l) => `  limitation: ${l}`),
          ]);
        }
        const provider =
          (opts.provider as ProviderId | undefined) ??
          (opts.account ? getProfile(ctx, String(opts.account)).providerId : undefined);
        const created = createAgent(ctx, {
          name: String(opts.name),
          role: String(opts.role),
          ...(opts.instructions ? { systemInstructions: String(opts.instructions) } : {}),
          ...(opts.skills ? { skills: opts.skills as string[] } : {}),
          ...(opts.tools ? { allowedMcpTools: opts.tools as string[] } : {}),
          ...(provider
            ? { providerPreferences: [{ provider, ...(opts.model ? { model: String(opts.model) } : {}) }] }
            : {}),
          ...(opts.policy ? { accountPolicy: String(opts.policy) } : {}),
          ...(opts.account ? { account: String(opts.account) } : {}),
          ...(opts.reviewAuthority ? { reviewAuthority: opts.reviewAuthority as never } : {}),
          ...(opts.maxParallel !== undefined ? { maxParallel: Number(opts.maxParallel) } : {}),
          ...(project ? { projects: [project.id] } : {}),
          actor: operatorActor(),
        });
        emit(opts, created, (a) => `${a.name} (${a.id}) role=${a.role}`);
      }),
    );
  agent.command('list').action(
    action((ctx, opts) => {
      const policies = new Map(listAccountPolicies(ctx).map((p) => [p.id, p]));
      const projects = new Map(listProjects(ctx).map((p) => [p.id, p.name]));
      emit(opts, listAgents(ctx), (rows) =>
        table(
          rows.map((a) => {
            const p = a.accountPolicyId ? policies.get(a.accountPolicyId) : undefined;
            return {
              name: a.name,
              role: a.role,
              managed: a.managed,
              providers: a.providerPreferences.map((pref) => pref.provider).join(','),
              accounts: p ? `${p.profiles.join(' → ')} (${p.name})` : '—',
              projects: a.projectIds.length ? a.projectIds.map((id) => projects.get(id) ?? id).join(',') : 'all',
            };
          }),
        ),
      );
    }),
  );
  agent
    .command('show <agent>')
    .action(action((ctx, opts, ref: string) => emit(opts, getAgent(ctx, ref), (a) => JSON.stringify(a, null, 2))));
  agent
    .command('update <agent>')
    .description('change an agent; running sessions keep their settings, new tasks use the new ones')
    .option('--role <role>', 'engineer | architect | reviewer | ...')
    .option('--provider <provider>', 'preferred provider')
    .option('--model <model>', 'preferred model')
    .option('--account <ref>', 'switch to a single account, e.g. claude/work')
    .option('--policy <name>', 'switch to an account policy')
    .option('--instructions <text>', 'system instructions (empty string clears them)')
    .option('--skills <names>', 'skills', list)
    .option('--tools <names>', 'allowed MCP tools', list)
    .option('--all-tools', 'allow all agent tools again')
    .option('--review-authority <level>', 'none | advisory | required')
    .option('--max-parallel <n>', 'max concurrent sessions', Number)
    .option('--projects <names>', 'only work on these projects', list)
    .option('--all-projects', 'work on every registered project')
    .action(
      action((ctx, opts, ref: string) => {
        const current = getAgent(ctx, ref);
        const preferred = current.providerPreferences[0];
        const provider =
          (opts.provider as ProviderId | undefined) ??
          (opts.account ? getProfile(ctx, String(opts.account)).providerId : undefined) ??
          preferred?.provider;
        if (opts.model && !provider) {
          throw new CrewError(
            'INVALID_INPUT',
            'Pass --provider with --model; this agent has no preferred provider yet',
          );
        }
        const providerChanged = provider !== preferred?.provider;
        const model = opts.model ? String(opts.model) : providerChanged ? undefined : preferred?.model;
        const providerPreferences =
          provider && (opts.model || providerChanged)
            ? [{ provider, ...(model ? { model } : {}) }, ...current.providerPreferences.slice(1)]
            : undefined;
        const changed = updateAgent(ctx, ref, {
          ...(opts.role ? { role: String(opts.role) } : {}),
          ...(providerPreferences ? { providerPreferences } : {}),
          ...(opts.account ? { account: String(opts.account) } : {}),
          ...(opts.policy ? { accountPolicy: String(opts.policy) } : {}),
          ...(opts.instructions !== undefined ? { systemInstructions: String(opts.instructions) || null } : {}),
          ...(opts.skills ? { skills: opts.skills as string[] } : {}),
          ...(opts.allTools
            ? { allowedMcpTools: null }
            : opts.tools
              ? { allowedMcpTools: opts.tools as string[] }
              : {}),
          ...(opts.reviewAuthority ? { reviewAuthority: opts.reviewAuthority as never } : {}),
          ...(opts.maxParallel !== undefined ? { maxParallel: Number(opts.maxParallel) } : {}),
          ...(opts.allProjects ? { projects: null } : opts.projects ? { projects: opts.projects as string[] } : {}),
          actor: operatorActor(),
        });
        emit(opts, changed, (c) => [
          `updated ${c.agent.name}`,
          ...c.unusedPolicies.map(
            (p) => `  policy ${p} is no longer used; remove it with: crew account policy remove ${p}`,
          ),
        ]);
      }),
    );
  withMutationOptions(
    agent
      .command('remove <agent>')
      .description('remove an agent; refuses while it has running sessions or claimed tasks'),
  ).action(
    action(async (ctx, opts, ref: string) => {
      if (!opts.dryRun) await confirm(opts, `Remove agent ${ref}?`);
      const removed = removeAgent(ctx, ref, { dryRun: Boolean(opts.dryRun), actor: operatorActor() });
      emit(opts, removed, (r) => [
        `${opts.dryRun ? 'would remove' : 'removed'} ${r.agent.name}`,
        ...(r.unassignedTasks.length ? [`  unassigned tasks: ${r.unassignedTasks.join(', ')}`] : []),
        ...r.unusedPolicies.map(
          (p) => `  policy ${p} is no longer used; remove it with: crew account policy remove ${p}`,
        ),
      ]);
    }),
  );
  agent
    .command('run <agent>')
    .description('claim a task, allocate its worktree and run a managed session (stays attached until it ends)')
    .requiredOption('--task <taskId>')
    .option('--model <model>')
    .action(
      action(async (ctx, opts, ref: string) => {
        const dispatch = await dispatchTask(ctx, {
          taskId: String(opts.task),
          agent: ref,
          actor: operatorActor(),
          ...(opts.model ? { model: String(opts.model) } : {}),
        });
        const watch = watchSession(
          ctx,
          opts,
          dispatch.session,
          `Running ${dispatch.claim.taskId} with ${ref} in ${dispatch.claim.worktreePath ?? 'its worktree'}`,
        );
        let outcome: Awaited<typeof dispatch.done>;
        try {
          outcome = await dispatch.done;
        } finally {
          watch.stop();
        }
        emit(
          opts,
          { claim: dispatch.claim, session: dispatch.session, outcome },
          (d) => `outcome: ${JSON.stringify(d.outcome)}`,
        );
      }),
    );
  withMutationOptions(agent.command('stop <sessionId>').option('--reason <text>')).action(
    action(async (ctx, opts, sessionId: string) => {
      await confirm(opts, `Cancel session ${sessionId} and terminate its process tree?`);
      const record = await stopSession(ctx, sessionId, {
        actor: operatorActor(),
        reason: (opts.reason as string | undefined) ?? 'operator request',
      });
      emit(opts, record, (r) => `${r.id} ${r.state}`);
    }),
  );
  agent
    .command('sessions')
    .option('--agent <agent>')
    .option('--task <taskId>')
    .action(
      action((ctx, opts) =>
        emit(
          opts,
          listSessions(ctx, {
            ...(opts.agent ? { agentId: getAgent(ctx, String(opts.agent)).id } : {}),
            ...(opts.task ? { taskId: String(opts.task) } : {}),
          }),
          (rows) =>
            table(
              rows.map((s) => ({
                id: s.id,
                provider: s.providerId,
                model: s.model,
                task: s.taskId,
                state: s.state,
                started: s.startedAt,
                error: s.errorReason,
              })),
            ),
        ),
      ),
    );
  agent
    .command('logs <sessionId>')
    .option('--tail <bytes>', 'only the last N bytes', Number, 64 * 1024)
    .action(
      action((ctx, opts, sessionId: string) => {
        const log = readSessionLog(ctx, sessionId, { tailBytes: Number(opts.tail) });
        if (opts.json) return emit(opts, log, () => '');
        process.stdout.write(log.content);
      }),
    );

  const team = program.command('team').description('teams of agents');
  team
    .command('create <name>')
    .option('--description <text>')
    .action(
      action((ctx, opts, name: string) =>
        emit(
          opts,
          createTeam(ctx, {
            name,
            ...(opts.description ? { description: String(opts.description) } : {}),
            actor: operatorActor(),
          }),
          (t) => `team ${t.name} (${t.id})`,
        ),
      ),
    );
  team
    .command('list')
    .action(
      action((ctx, opts) => emit(opts, listTeams(ctx), (rows) => table(rows as unknown as Record<string, unknown>[]))),
    );
  team
    .command('assign <team> <agent>')
    .option('--role <role>')
    .action(
      action((ctx, opts, teamName: string, agentRef: string) =>
        emit(
          opts,
          assignAgentToTeam(ctx, {
            agent: agentRef,
            team: teamName,
            ...(opts.role ? { role: String(opts.role) } : {}),
            actor: operatorActor(),
          }),
          (t) => `${agentRef} → ${t.name}`,
        ),
      ),
    );
}
