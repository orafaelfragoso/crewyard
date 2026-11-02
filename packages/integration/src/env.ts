import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, CrewError, ensureDir, git, nowIso, sha256 } from '@crewyard/core';
import {
  assertRemoteMatches,
  type ConditionalCache,
  GitHubClient,
  type GitHubClientOptions,
  ghTokenProvider,
  type RepositoryCoordinates,
  type TokenProvider,
} from '@crewyard/github';
import { getProject, getRepository, projectConfig, type Repository } from '@crewyard/projects';
import { type CrewContext, one, recordTransition } from '@crewyard/storage';
import type { GitHubClientFactory, IntegrationEnv, TaskHookEvent, TaskHooks } from './types.ts';

export const CREW_INTEGRATION_ACTOR: Actor = { kind: 'service', id: 'integration' };

export function coordinates(repository: Repository): RepositoryCoordinates {
  if (!repository.remoteOwner || !repository.remoteName) {
    throw new CrewError('INVALID_INPUT', `Repository ${repository.id} has no GitHub remote`, {
      suggestion: 'Add a GitHub `origin` remote and run `crew project sync`.',
    });
  }
  return { host: repository.remoteHost ?? 'github.com', owner: repository.remoteOwner, name: repository.remoteName };
}

export function syncStateCache(ctx: CrewContext, repositoryId: string): ConditionalCache {
  const dir = join(ctx.dirs.data, 'cache', 'github', repositoryId);
  const fileFor = (key: string) => join(dir, `${sha256(key).slice(0, 40)}.json`);
  const stateKey = (key: string) => `github:etag:${repositoryId}:${sha256(key).slice(0, 40)}`;
  return {
    get(key) {
      const row = one<{ etag: string | null }>(
        ctx.store.db,
        'SELECT etag FROM sync_state WHERE key = ?',
        stateKey(key),
      );
      const file = fileFor(key);
      if (!row?.etag || !existsSync(file)) return null;
      try {
        return { etag: row.etag, body: JSON.parse(readFileSync(file, 'utf8')) as unknown };
      } catch {
        return null;
      }
    },
    set(key, entry) {
      ensureDir(dir);
      writeFileSync(fileFor(key), JSON.stringify(entry.body), { mode: 0o600 });
      const at = nowIso(ctx.clock);
      ctx.store.immediate((db) => {
        db.query(
          `INSERT INTO sync_state (key, etag, last_success_at, last_attempt_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at`,
        ).run(stateKey(key), entry.etag, at, at);
      });
    },
  };
}

export interface ClientFactoryOptions extends Partial<Omit<GitHubClientOptions, 'repository' | 'token' | 'cache'>> {
  token?: TokenProvider;
  conditional?: boolean;
}

export function createClientFactory(ctx: CrewContext, options: ClientFactoryOptions = {}): GitHubClientFactory {
  const clients = new Map<string, GitHubClient>();
  return (repository) => {
    const existing = clients.get(repository.id);
    if (existing) return existing;
    const repo = coordinates(repository);
    const { token, conditional, ...rest } = options;
    const client = new GitHubClient({
      ...rest,
      repository: repo,
      token: token ?? ghTokenProvider({ host: repo.host, configDir: repository.ghConfigDir }),
      ...(conditional === false ? {} : { cache: syncStateCache(ctx, repository.id) }),
    });
    clients.set(repository.id, client);
    return client;
  };
}

export function repositoryFor(ctx: CrewContext, repositoryId: string): Repository {
  return getRepository(ctx, repositoryId);
}

export function configFor(ctx: CrewContext, env: IntegrationEnv, projectId: string): CrewConfig {
  return env.config ?? projectConfig(ctx, projectId);
}

export function autonomyFor(ctx: CrewContext, projectId: string) {
  return getProject(ctx, projectId).autonomy;
}

export async function configuredRemoteUrl(repoPath: string, remote = 'origin'): Promise<string | null> {
  const result = await git(repoPath, ['config', '--get', `remote.${remote}.url`], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function clientFor(ctx: CrewContext, env: IntegrationEnv, repository: Repository): Promise<GitHubClient> {
  const remoteUrl = env.remoteUrl
    ? await env.remoteUrl(repository)
    : await configuredRemoteUrl(repository.canonicalPath);
  assertRemoteMatches(coordinates(repository), remoteUrl);
  return (env.github ?? createClientFactory(ctx))(repository);
}

export function leadershipScope(repositoryId: string, baseBranch: string): string {
  return `integration:${repositoryId}:${baseBranch}`;
}

export type PendingHook = {
  [K in keyof TaskHooks]-?: { name: K; event: Parameters<NonNullable<TaskHooks[K]>>[0] };
}[keyof TaskHooks];

export async function runHooks(ctx: CrewContext, hooks: TaskHooks | undefined, pending: PendingHook[]): Promise<void> {
  if (!hooks) return;
  for (const call of pending) {
    const fn = hooks[call.name] as ((event: TaskHookEvent) => void | Promise<void>) | undefined;
    if (!fn) continue;
    try {
      await fn.call(hooks, call.event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn('task hook failed', { hook: call.name, prId: call.event.prId, error: message });
      const at = nowIso(ctx.clock);
      ctx.store.immediate((db) =>
        recordTransition(
          db,
          {
            type: 'integration.hook_failed',
            actor: CREW_INTEGRATION_ACTOR,
            taskId: call.event.taskId,
            prId: call.event.prId,
            payload: { hook: call.name, error: message },
          },
          { action: 'integration.hook', input: { hook: call.name }, decision: 'failed' },
          at,
        ),
      );
    }
  }
}
