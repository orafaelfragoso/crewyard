import { createInterface } from 'node:readline/promises';
import {
  addProfile,
  assignAgentToTeam,
  createAccountPolicy,
  createAgent,
  createTeam,
  getAgent,
  getProfile,
  listAgents,
  listProfiles,
  listSessions,
  listTeams,
  readSessionLog,
  registerUnmanagedAgent,
  removeProfile,
  stopSession,
  testProfile,
} from '@agent-rail/agents';
import { dispatchTask } from '@agent-rail/application';
import { type AuthMechanism, type ProviderId, RailError } from '@agent-rail/core';
import { resolveProject } from '@agent-rail/projects';
import type { Command } from 'commander';
import { confirm, emit, keyValues, table, writeLine } from '../output.ts';
import { action, operatorActor, withMutationOptions } from '../program.ts';

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
    if (!value) throw new RailError('INVALID_INPUT', `Environment variable ${String(opts.apiKeyEnv)} is empty`);
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
          ...(opts.command ? { command: opts.command } : {}),
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
        emit(
          opts,
          profile,
          (p) =>
            `${p.providerId}/${p.name} (${p.id}) auth=${p.authMechanism}${p.configRoot ? ` config=${p.configRoot}` : ''}`,
        );
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
      await confirm(opts, `Remove profile ${ref} and its stored credential?`);
      emit(
        opts,
        await removeProfile(ctx, ref, { purgeConfigRoot: Boolean(opts.purgeConfigRoot), actor: operatorActor() }),
        () => `removed ${ref}`,
      );
    }),
  );
  account
    .command('policy <name>')
    .description('create an ordered account policy for agents')
    .requiredOption('--profiles <refs>', 'ordered profile refs', list)
    .option('--allow-fallback', 'explicitly allow falling back to later profiles')
    .option('--models <models>', 'model allowlist', list)
    .action(
      action((ctx, opts, name: string) =>
        emit(
          opts,
          createAccountPolicy(ctx, {
            name,
            profiles: opts.profiles as string[],
            allowFallback: Boolean(opts.allowFallback),
            ...(opts.models ? { models: opts.models as string[] } : {}),
          }),
          (p) => `policy ${p.name} (${p.id})`,
        ),
      ),
    );

  const agent = program.command('agent').description('reusable agent definitions and managed sessions');
  agent
    .command('create')
    .requiredOption('--name <name>')
    .option('--role <role>', 'engineer | architect | reviewer | ...', 'engineer')
    .option('--provider <provider>', 'preferred provider')
    .option('--model <model>', 'preferred model')
    .option('--account <ref>', 'account profile ref (creates a single-profile policy)')
    .option('--policy <name>', 'account policy name')
    .option('--instructions <text>', 'system instructions')
    .option('--skills <names>', 'skills', list)
    .option('--tools <names>', 'allowed MCP tools (default: all agent tools)', list)
    .option('--review-authority <level>', 'none | advisory | required')
    .option('--max-parallel <n>', 'max concurrent sessions', Number)
    .option('--unmanaged', 'register an external agent that Rail does not launch')
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
        let policy = opts.policy ? String(opts.policy) : null;
        if (!policy && opts.account) {
          const profile = getProfile(ctx, String(opts.account));
          policy = createAccountPolicy(ctx, {
            name: `${String(opts.name)}-${profile.name}`,
            profiles: [profile.id],
            allowFallback: false,
          }).name;
        }
        const created = createAgent(ctx, {
          name: String(opts.name),
          role: String(opts.role),
          ...(opts.instructions ? { systemInstructions: String(opts.instructions) } : {}),
          ...(opts.skills ? { skills: opts.skills as string[] } : {}),
          ...(opts.tools ? { allowedMcpTools: opts.tools as string[] } : {}),
          ...(opts.provider
            ? {
                providerPreferences: [
                  { provider: opts.provider as ProviderId, ...(opts.model ? { model: String(opts.model) } : {}) },
                ],
              }
            : {}),
          ...(policy ? { accountPolicy: policy } : {}),
          ...(opts.reviewAuthority ? { reviewAuthority: opts.reviewAuthority as never } : {}),
          ...(opts.maxParallel ? { maxParallel: Number(opts.maxParallel) } : {}),
          ...(project ? { projects: [project.id] } : {}),
          actor: operatorActor(),
        });
        emit(opts, created, (a) => `${a.name} (${a.id}) role=${a.role}`);
      }),
    );
  agent.command('list').action(
    action((ctx, opts) =>
      emit(opts, listAgents(ctx), (rows) =>
        table(
          rows.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            managed: a.managed,
            providers: a.providerPreferences.map((p) => p.provider).join(','),
          })),
        ),
      ),
    ),
  );
  agent
    .command('show <agent>')
    .action(action((ctx, opts, ref: string) => emit(opts, getAgent(ctx, ref), (a) => JSON.stringify(a, null, 2))));
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
        if (!opts.json) {
          writeLine(
            `session ${dispatch.session.sessionId} (${dispatch.session.providerId}/${dispatch.session.profileRef}) on ${dispatch.claim.taskId}`,
          );
          writeLine(`worktree ${dispatch.claim.worktreePath ?? '—'} · log ${dispatch.session.logPath}`);
          writeLine(`routing: ${dispatch.session.routing.join('; ')}`);
        }
        const stop = () =>
          void stopSession(ctx, dispatch.session.sessionId, { actor: operatorActor(), reason: 'operator interrupt' });
        process.once('SIGINT', stop);
        const outcome = await dispatch.done;
        process.off('SIGINT', stop);
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
        process.stdout.write(typeof log === 'string' ? log : String((log as { text?: string }).text ?? ''));
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
