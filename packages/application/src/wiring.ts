import {
  type IntegrationEnv,
  processIntegrationOutbox,
  queueTick,
  syncRepository,
  updateQueueEntry,
} from '@crewyard/integration';
import { listProjects, loadProjectConfig, primaryRepository, type Repository } from '@crewyard/projects';
import type { RemoteRecovery } from '@crewyard/recovery';
import type { CrewContext } from '@crewyard/storage';
import type { QueueActions } from './dashboard-actions.ts';
import { INTEGRATION_ACTOR, integrationEnv, reconcileMergedTasks } from './integration.ts';
import { publishTask, tasksAwaitingPublication } from './publish.ts';
import type { ProjectCycle, ServiceOptions } from './service-loop.ts';

export function hasGitHubRemote(repo: Repository): boolean {
  return repo.remoteOwner !== null && (repo.remoteHost === 'github.com' || Boolean(process.env.CREW_GITHUB_API_URL));
}

function githubCycle(
  name: string,
  interval: (ctx: CrewContext, projectId: string) => number,
  body: (ctx: CrewContext, repo: Repository, leaderId: string) => Promise<Record<string, unknown>>,
): ProjectCycle {
  return {
    name,
    intervalSeconds: interval,
    async run(ctx, input) {
      const repo = primaryRepository(ctx, input.projectId);
      if (!hasGitHubRemote(repo)) return {};
      return body(ctx, repo, input.leaderId);
    },
  };
}

export type EnvFactory = (ctx: CrewContext) => IntegrationEnv;

export function integrationCycles(envFor: EnvFactory = integrationEnv): ProjectCycle[] {
  const poll = (ctx: CrewContext, projectId: string) =>
    loadProjectConfig(ctx, projectId).config.integration.poll_interval_seconds;
  const fast = () => 5;
  return [
    githubCycle('sync', poll, async (ctx, repo) => {
      const result = await syncRepository(ctx, repo.id, envFor(ctx));
      return { synced: result as unknown as Record<string, unknown> };
    }),
    githubCycle('publish', fast, async (ctx, repo, leaderId) => {
      const published: Record<string, unknown>[] = [];
      for (const taskId of tasksAwaitingPublication(ctx, repo.projectId)) {
        try {
          const r = await publishTask(ctx, { taskId, actor: INTEGRATION_ACTOR, leaderId, env: envFor(ctx) });
          published.push({ taskId, pr: r.pullRequest?.number ?? null, queued: r.queued });
        } catch (error) {
          published.push({ taskId, error: (error as Error).message });
        }
      }
      return published.length ? { published } : {};
    }),
    githubCycle('outbox', fast, async (ctx, _repo, leaderId) => {
      const report = await processIntegrationOutbox(ctx, { leaderId, env: envFor(ctx) });
      return report.processed > 0 ? { outbox: report as unknown as Record<string, unknown> } : {};
    }),
    githubCycle('queue', fast, async (ctx, repo, leaderId) => {
      const env = envFor(ctx);
      const result = await queueTick(ctx, repo.id, { leaderId, env, sync: false });
      const reconciled = await reconcileMergedTasks(ctx, repo.id, env);
      return { queue: result as unknown as Record<string, unknown>, ...(reconciled.length ? { reconciled } : {}) };
    }),
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

export function defaultServiceOptions(envFor: EnvFactory = integrationEnv): ServiceOptions {
  return { cycles: integrationCycles(envFor), remoteRecovery: [githubRecovery(envFor)] };
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
