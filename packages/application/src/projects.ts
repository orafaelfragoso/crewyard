import { basename, join } from 'node:path';
import { REPO_CONFIG_RELATIVE, renderConfigTemplate } from '@crewyard/config';
import {
  type Actor,
  type AutonomyMode,
  CrewError,
  ensureDir,
  git,
  isGitRepository,
  remoteIdentity,
  repositoryRoot,
  revParse,
  which,
  writeFileIfAbsent,
} from '@crewyard/core';
import { type IndexResult, indexRepository, indexStatus } from '@crewyard/indexing';
import {
  getProject,
  loadProjectConfig,
  type Project,
  primaryRepository,
  type Repository,
  recordPolicyRevision,
  registerProject,
  resolveProject,
} from '@crewyard/projects';
import type { CrewContext } from '@crewyard/storage';
import { serviceStatus } from './service-control.ts';

export interface ReadinessItem {
  id: string;
  ok: boolean;
  message: string;
  action?: string;
}

export interface InitResult {
  project: Project;
  repository: Repository;
  created: boolean;
  configFile: string;
  configCreated: boolean;
  baseBranch: string;
  index: IndexResult | null;
  readiness: ReadinessItem[];
}

async function detectBaseBranch(root: string): Promise<string> {
  const remoteHead = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  });
  if (remoteHead.exitCode === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, '');
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    if (await revParse(root, `refs/heads/${candidate}`)) return candidate;
  }
  const current = await git(root, ['branch', '--show-current'], { allowFailure: true });
  if (current.stdout.trim()) return current.stdout.trim();
  throw new CrewError('INVALID_INPUT', 'Cannot determine the default branch', { suggestion: 'Pass --base BRANCH.' });
}

export interface InitInput {
  repoPath: string;
  baseBranch?: string;
  name?: string;
  autonomy?: AutonomyMode;
  index?: boolean;
  actor: Actor;
  hostReadiness?: () => Promise<ReadinessItem[]>;
}

export async function initRepository(ctx: CrewContext, input: InitInput): Promise<InitResult> {
  if (!(await isGitRepository(input.repoPath))) {
    throw new CrewError('INVALID_INPUT', `${input.repoPath} is not inside a Git working tree`, {
      suggestion: 'Run `crew init` inside a Git repository or pass --repo PATH.',
    });
  }
  const root = await repositoryRoot(input.repoPath);
  const remote = await remoteIdentity(root);
  const baseBranch = input.baseBranch ?? (await detectBaseBranch(root));
  if (!(await revParse(root, baseBranch)) && !(await revParse(root, `origin/${baseBranch}`))) {
    throw new CrewError('INVALID_INPUT', `Base branch ${baseBranch} does not exist locally or on origin`, {
      suggestion: 'Pass --base with an existing branch.',
    });
  }
  const configFile = join(root, REPO_CONFIG_RELATIVE);
  const name = input.name ?? (remote?.name ?? basename(root)).replace(/[^A-Za-z0-9._-]/g, '-');
  ensureDir(join(root, '.crewyard'));
  const configCreated = writeFileIfAbsent(
    configFile,
    renderConfigTemplate({ projectName: name, baseBranch, ...(input.autonomy ? { autonomy: input.autonomy } : {}) }),
  );
  const registered = await registerProject(ctx, {
    repoPath: root,
    name,
    baseBranch,
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
    configPath: configFile,
    actor: input.actor,
  });
  const loaded = loadProjectConfig(ctx, registered.project.id);
  recordPolicyRevision(ctx, registered.project.id, loaded.config, `${input.actor.kind}:${input.actor.id}`);

  let index: IndexResult | null = null;
  const readiness: ReadinessItem[] = [];
  if (input.index !== false && loaded.config.index.enabled) {
    try {
      index = await indexRepository(ctx, {
        repositoryId: registered.repository.id,
        ref: baseBranch,
        config: loaded.config.index,
        actor: input.actor,
      });
    } catch (error) {
      readiness.push({ id: 'index', ok: false, message: (error as Error).message, action: 'crew index build' });
    }
  }
  readiness.push(...(await readinessReport(ctx, registered.project.id)));
  if (input.hostReadiness) readiness.push(...(await input.hostReadiness()));
  return { ...registered, configFile, configCreated, baseBranch, index, readiness };
}

export async function readinessReport(ctx: CrewContext, projectId: string): Promise<ReadinessItem[]> {
  const repo = primaryRepository(ctx, projectId);
  const loaded = loadProjectConfig(ctx, projectId);
  const items: ReadinessItem[] = [
    { id: 'git', ok: true, message: `repository ${repo.canonicalPath} on base ${repo.defaultBase}` },
    {
      id: 'remote',
      ok: repo.remoteHost === 'github.com',
      message: repo.remoteOwner ? `${repo.remoteHost}/${repo.remoteOwner}/${repo.remoteName}` : 'no origin remote',
      ...(repo.remoteHost === 'github.com' ? {} : { action: 'Add a GitHub `origin` remote for PR integration.' }),
    },
    {
      id: 'gh',
      ok: which('gh') !== null,
      message: which('gh') ? 'GitHub CLI available' : 'GitHub CLI missing',
      ...(which('gh') ? {} : { action: 'Install gh and run `gh auth login`.' }),
    },
    {
      id: 'config',
      ok: true,
      message: `autonomy ${getProject(ctx, projectId).autonomy}, integration ${loaded.config.integration.mode}`,
    },
  ];
  try {
    const status = await indexStatus(ctx, { repositoryId: repo.id, ref: repo.defaultBase });
    items.push({
      id: 'index',
      ok: status.status === 'fresh',
      message: `index ${status.status}${status.snapshot ? ` at ${status.snapshot.commitSha.slice(0, 12)}` : ''}`,
      ...(status.status === 'fresh' ? {} : { action: status.suggestion ?? 'crew index build' }),
    });
  } catch (error) {
    items.push({ id: 'index', ok: false, message: (error as Error).message, action: 'crew index build' });
  }
  items.push({
    id: 'agents',
    ok: (ctx.store.db.query('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n > 0,
    message: 'agent definitions',
    action:
      'crew account add --provider claude --name personal --use-default-config && crew agent create --name engineer --provider claude --account claude/personal (see docs/getting-started.md)',
  });
  const service = serviceStatus(ctx);
  items.push({
    id: 'service',
    ok: service.running,
    message: service.note,
    ...(service.running ? {} : { action: 'crew service start (or crew service install)' }),
  });
  return items;
}

export async function projectForRepositoryPath(
  ctx: CrewContext,
  selector: string | undefined,
): Promise<{ project: Project; repository: Repository }> {
  const project = await resolveProject(ctx, selector);
  return { project, repository: primaryRepository(ctx, project.id) };
}
