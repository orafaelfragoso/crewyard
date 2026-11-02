import { join } from 'node:path';
import { type RailConfig, type RailConfigInput, railConfigSchema } from '@agent-rail/config';
import { type AutonomyMode, type Clock, git, gitText } from '@agent-rail/core';
import { staticTokenProvider } from '@agent-rail/github';
import { createClientFactory, type IntegrationEnv, type TaskHooks } from '@agent-rail/integration';
import { registerProject } from '@agent-rail/projects';
import { createTempGitRepo, createTestContext, type TestContext, tempDir, writeFiles } from '../helpers/index.ts';
import { type MockGitHub, startMockGitHub } from '../helpers/mock-github.ts';

export interface HookCall {
  name: keyof TaskHooks;
  event: Record<string, unknown>;
}

export interface GitHubFixture {
  ctx: TestContext;
  mock: MockGitHub;
  bare: string;
  repo: string;
  repositoryId: string;
  projectId: string;
  config: RailConfig;
  env: IntegrationEnv;
  hookCalls: HookCall[];
  pushBranch(name: string, files: Record<string, string>, from?: string): Promise<string>;
  advanceBase(files: Record<string, string>, branch?: string): Promise<string>;
  cleanup(): void;
}

export interface FixtureOptions {
  files?: Record<string, string>;
  config?: Omit<RailConfigInput, 'version' | 'project'>;
  autonomy?: AutonomyMode;
  clock?: Clock;
  timeoutMs?: number;
}

function recordingHooks(calls: HookCall[]): TaskHooks {
  const record = (name: keyof TaskHooks) => (event: object) => {
    calls.push({ name, event: { ...event } });
  };
  return {
    onQueued: record('onQueued'),
    onValidating: record('onValidating'),
    onMerged: record('onMerged'),
    onBlocked: record('onBlocked'),
    onEscalated: record('onEscalated'),
    onRevisionRequired: record('onRevisionRequired'),
  };
}

export async function createGitHubFixture(options: FixtureOptions = {}): Promise<GitHubFixture> {
  const ctx = createTestContext(options.clock ? { clock: options.clock } : {});
  const bare = join(tempDir('rail-origin-'), 'origin.git');
  await git(ctx.root, ['init', '-q', '--bare', '-b', 'main', bare]);
  const mock = startMockGitHub({ gitDir: bare });
  const repo = await createTempGitRepo(
    options.files ?? { 'README.md': '# widgets\n', 'src/index.ts': 'export {};\n' },
    {
      remote: mock.remoteUrl,
    },
  );
  await git(repo, ['config', `url.${bare}.insteadOf`, mock.remoteUrl]);
  await git(repo, ['push', '-q', 'origin', 'main']);
  const autonomy = options.autonomy ?? 'autopilot';
  const { project, repository } = await registerProject(ctx, {
    repoPath: repo,
    baseBranch: 'main',
    autonomy,
    actor: { kind: 'operator', id: 'tester' },
  });
  ctx.store.db
    .query(
      `UPDATE repositories SET remote_url = ?, remote_host = 'github.com', remote_owner = ?, remote_name = ? WHERE id = ?`,
    )
    .run(mock.remoteUrl, mock.owner, mock.name, repository.id);
  const config = railConfigSchema.parse({
    version: 1,
    project: { name: project.name, autonomy },
    ...options.config,
    integration: { merge_method: 'squash', ...options.config?.integration },
  });
  const hookCalls: HookCall[] = [];
  const env: IntegrationEnv = {
    config,
    hooks: recordingHooks(hookCalls),
    github: createClientFactory(ctx, {
      baseUrl: mock.url,
      token: staticTokenProvider(mock.token),
      timeoutMs: options.timeoutMs ?? 3_000,
      retryBaseMs: 1,
      maxRetries: 1,
    }),
  };
  const pushBranch = async (name: string, files: Record<string, string>, from = 'main') => {
    await git(repo, ['fetch', '-q', 'origin']);
    await git(repo, ['checkout', '-q', '-B', name, `origin/${from}`]);
    writeFiles(repo, files);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', `change on ${name}`]);
    await git(repo, ['push', '-q', '-f', 'origin', `${name}:${name}`]);
    const sha = await gitText(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['checkout', '-q', 'main']);
    return sha;
  };
  const advanceBase = async (files: Record<string, string>, branch = 'main') => {
    const sha = await pushBranch(`advance-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, files, branch);
    mock.setBranch(branch, sha);
    return sha;
  };
  return {
    ctx,
    mock,
    bare,
    repo,
    repositoryId: repository.id,
    projectId: project.id,
    config,
    env,
    hookCalls,
    pushBranch,
    advanceBase,
    cleanup() {
      mock.stop();
      ctx.cleanup();
    },
  };
}
