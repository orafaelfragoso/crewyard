import { type Actor, isCrewError } from '@crewyard/core';
import {
  type IntegrationEnv,
  processIntegrationOutbox,
  queueTick,
  syncRepository,
  type TaskHooks,
  updateQueueEntry,
} from '@crewyard/integration';
import { listProjects, loadProjectConfig, primaryRepository, type Repository } from '@crewyard/projects';
import type { RemoteRecovery } from '@crewyard/recovery';
import type { CrewContext } from '@crewyard/storage';
import { pruneBuildOutput } from '@crewyard/workspaces';
import type { QueueActions } from './dashboard-actions.ts';
import { INTEGRATION_ACTOR, integrationEnv, reconcileMergedTasks, reviewPullRequest } from './integration.ts';
import { cleanFinishedWorkspaces } from './maintenance.ts';
import { blockDivergedPublication, publishTask, tasksAwaitingPublication } from './publish.ts';
import type { ProjectCycle, ServiceOptions } from './service-loop.ts';
import { resumeSessionRetries } from './session-retries.ts';

export function hasGitHubRemote(repo: Repository): boolean {
  return repo.remoteOwner !== null && (repo.remoteHost === 'github.com' || Boolean(process.env.CREW_GITHUB_API_URL));
}

type Background = (work: Promise<unknown>) => void;

function githubCycle(
  name: string,
  interval: (ctx: CrewContext, projectId: string) => number,
  body: (
    ctx: CrewContext,
    repo: Repository,
    leaderId: string,
    background: Background,
  ) => Promise<Record<string, unknown>>,
): ProjectCycle {
  return {
    name,
    intervalSeconds: interval,
    async run(ctx, input) {
      const repo = primaryRepository(ctx, input.projectId);
      if (!hasGitHubRemote(repo)) return {};
      return body(ctx, repo, input.leaderId, input.background);
    },
  };
}

export type EnvFactory = (ctx: CrewContext) => IntegrationEnv;

export function integrationCycles(envFor: EnvFactory = integrationEnv): ProjectCycle[] {
  const poll = (ctx: CrewContext, projectId: string) =>
    loadProjectConfig(ctx, projectId).config.integration.poll_interval_seconds;
  const fast = () => 5;
  const reviewing = new Set<string>();
  const reviewInBackground =
    (ctx: CrewContext, env: IntegrationEnv, background: Background): TaskHooks['onReviewRequired'] =>
    (event) => {
      const key = `${event.prId}@${event.headSha}`;
      if (reviewing.has(key)) return;
      reviewing.add(key);
      background(reviewPullRequest(ctx, { prId: event.prId }, env).finally(() => reviewing.delete(key)));
    };
  return [
    githubCycle('sync', poll, async (ctx, repo) => {
      const result = await syncRepository(ctx, repo.id, envFor(ctx));
      return { synced: result as unknown as Record<string, unknown> };
    }),
    githubCycle('publish', fast, async (ctx, repo, leaderId, background) => {
      const published: Record<string, unknown>[] = [];
      for (const taskId of tasksAwaitingPublication(ctx, repo.projectId)) {
        try {
          const r = await publishTask(ctx, {
            taskId,
            actor: INTEGRATION_ACTOR,
            leaderId,
            env: envFor(ctx),
            background,
          });
          published.push({ taskId, pr: r.pullRequest?.number ?? null, queued: r.queued });
        } catch (error) {
          if (isCrewError(error) && error.code === 'HEAD_MISMATCH') {
            blockDivergedPublication(ctx, taskId, error, INTEGRATION_ACTOR);
          }
          published.push({ taskId, error: (error as Error).message });
        }
      }
      return published.length ? { published } : {};
    }),
    githubCycle('outbox', fast, async (ctx, _repo, leaderId) => {
      const report = await processIntegrationOutbox(ctx, { leaderId, env: envFor(ctx) });
      return report.processed > 0 ? { outbox: report as unknown as Record<string, unknown> } : {};
    }),
    githubCycle('queue', fast, async (ctx, repo, leaderId, background) => {
      const env = envFor(ctx);
      const hooks = { ...env.hooks, onReviewRequired: reviewInBackground(ctx, env, background) };
      const result = await queueTick(ctx, repo.id, { leaderId, env: { ...env, hooks }, sync: false });
      const reconciled = await reconcileMergedTasks(ctx, repo.id, env);
      return { queue: result as unknown as Record<string, unknown>, ...(reconciled.length ? { reconciled } : {}) };
    }),
  ];
}

const MAINTENANCE_ACTOR: Actor = { kind: 'service', id: 'crew-maintenance' };

export function maintenanceCycles(): ProjectCycle[] {
  return [
    {
      name: 'retry',
      intervalSeconds: () => 30,
      async run(ctx, input) {
        const resumed = resumeSessionRetries(ctx, input.projectId, MAINTENANCE_ACTOR);
        return resumed.length ? { resumed } : {};
      },
    },
    {
      name: 'workspace-cleanup',
      intervalSeconds: () => 3_600,
      async run(ctx, input) {
        const repo = primaryRepository(ctx, input.projectId);
        const removed = await cleanFinishedWorkspaces(ctx, { repositoryId: repo.id, actor: MAINTENANCE_ACTOR });
        const pruned = await pruneBuildOutput(ctx, { repositoryId: repo.id, actor: MAINTENANCE_ACTOR });
        return {
          ...(removed.length ? { removed: removed.map((r) => r.workspace.id) } : {}),
          ...(pruned.length ? { pruned } : {}),
        };
      },
    },
  ];
}

export function githubRecovery(envFor: EnvFactory = integrationEnv): RemoteRecovery {
  return {
    name: 'reconcile-github',
    async run(ctx) {
      const results: Record<string, unknown> = {};
      for (const project of listProjects(ctx)) {
        const repo = primaryRepository(ctx, project.id);
        if (!hasGitHubRemote(repo)) continue;
        try {
          const env = envFor(ctx);
          await syncRepository(ctx, repo.id, env);
          await reconcileMergedTasks(ctx, repo.id, env);
          results[project.name] = 'synced';
        } catch (error) {
          results[project.name] = `sync failed: ${(error as Error).message}`;
        }
      }
      return results;
    },
  };
}

function onePerContext(envFor: EnvFactory): EnvFactory {
  const envs = new WeakMap<CrewContext, IntegrationEnv>();
  return (ctx) => {
    const env = envs.get(ctx) ?? envFor(ctx);
    envs.set(ctx, env);
    return env;
  };
}

export function defaultServiceOptions(envFor: EnvFactory = integrationEnv): ServiceOptions {
  const env = onePerContext(envFor);
  return { cycles: [...integrationCycles(env), ...maintenanceCycles()], remoteRecovery: [githubRecovery(env)] };
}

export function defaultQueueActions(): QueueActions {
  return {
    retry: async (ctx, entryId, reason, actor) => {
      await updateQueueEntry(ctx, { entryId, action: 'retry', reason }, actor, integrationEnv(ctx));
      return `queue entry ${entryId} retried`;
    },
    escalate: async (ctx, entryId, reason, actor) => {
      await updateQueueEntry(ctx, { entryId, action: 'escalate', reason }, actor, integrationEnv(ctx));
      return `queue entry ${entryId} escalated`;
    },
  };
}
