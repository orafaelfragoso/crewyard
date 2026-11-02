import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stopSession } from '@agent-rail/agents';
import { type Actor, nowIso, toRailError } from '@agent-rail/core';
import { setProjectFlags } from '@agent-rail/projects';
import type { RailContext } from '@agent-rail/storage';
import { decideTaskApproval, forceReleaseLease, showTask, transitionTask } from '@agent-rail/tasks';
import type { ActionResult, ContextSearchResult, DashboardActions } from '@agent-rail/tui';
import { runDoctor } from './doctor.ts';
import { exportEvents, metrics } from './events.ts';
import { searchContext } from './retrieval.ts';

export interface QueueActions {
  retry(ctx: RailContext, entryId: string, reason: string, actor: Actor): Promise<string> | string;
  escalate(ctx: RailContext, entryId: string, reason: string, actor: Actor): Promise<string> | string;
}

async function attempt(fn: () => Promise<string> | string): Promise<ActionResult> {
  try {
    return { ok: true, message: await fn() };
  } catch (error) {
    return { ok: false, message: toRailError(error).message };
  }
}

export function createDashboardActions(ctx: RailContext, actor: Actor, queue: QueueActions | null): DashboardActions {
  return {
    pauseProject: (projectId, paused) =>
      attempt(
        () =>
          `intake ${setProjectFlags(ctx, projectId, { intakePaused: paused }, actor).intakePaused ? 'paused' : 'resumed'}`,
      ),
    pauseWorkers: (projectId, paused) =>
      attempt(
        () =>
          `workers ${setProjectFlags(ctx, projectId, { workersPaused: paused }, actor).workersPaused ? 'paused' : 'resumed'}`,
      ),
    retryTask: (taskId, reason) =>
      attempt(() => {
        const detail = showTask(ctx, taskId);
        const result = detail.lease
          ? forceReleaseLease(ctx, taskId, { reason, actor, to: 'READY' })
          : transitionTask(ctx, { taskId, to: 'READY', actor, reason });
        return `${taskId}: ${result.from} → ${result.to}`;
      }),
    escalateTask: (taskId, reason) =>
      attempt(() => {
        const result = transitionTask(ctx, { taskId, to: 'ESCALATED', actor, reason, blockerReason: reason });
        return `${taskId}: ${result.from} → ${result.to}`;
      }),
    cancelSession: (sessionId) =>
      attempt(
        async () =>
          `${sessionId}: ${(await stopSession(ctx, sessionId, { actor, reason: 'cancelled from dashboard' })).state}`,
      ),
    approveTask: (taskId) =>
      attempt(() => `${taskId}: gate ${decideTaskApproval(ctx, taskId, 'approved', actor).status}`),
    retryQueueEntry: (entryId, reason) =>
      attempt(() => (queue ? queue.retry(ctx, entryId, reason, actor) : 'integration is not available')),
    escalateQueueEntry: (entryId, reason) =>
      attempt(() => (queue ? queue.escalate(ctx, entryId, reason, actor) : 'integration is not available')),
    openUrl: (url) =>
      attempt(async () => {
        if (!/^https:\/\/github\.com\//.test(url)) throw new Error('only GitHub URLs are opened');
        const cmd =
          process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
              ? ['cmd', '/c', 'start', '', url]
              : ['xdg-open', url];
        Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).unref();
        return `opened ${url}`;
      }),
    exportDiagnostics: () =>
      attempt(async () => {
        const dir = join(ctx.dirs.artifacts, `diagnostics-${nowIso(ctx.clock).replaceAll(':', '-')}`);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        await Bun.write(join(dir, 'doctor.json'), JSON.stringify(await runDoctor(ctx), null, 2));
        await Bun.write(join(dir, 'metrics.json'), JSON.stringify(metrics(ctx, null), null, 2));
        await exportEvents(ctx, join(dir, 'events.jsonl'));
        return `diagnostics written to ${dir} (redacted; nothing was sent anywhere)`;
      }),
    searchContext: async (projectId, query): Promise<ContextSearchResult> => {
      const result = await searchContext(ctx, { projectId, query, limit: 50 });
      return {
        commitSha: result.commitSha,
        retrievedAt: result.retrievedAt,
        tokenEstimate: result.hits.reduce((n, h) => n + Math.ceil(h.excerpt.length / 4), 0),
        warnings: result.indexStatus === 'fresh' ? [] : [`index ${result.indexStatus}`],
        hits: result.hits.map((h) => ({
          path: h.path,
          startLine: h.startLine,
          endLine: h.endLine,
          commitSha: result.commitSha,
          score: h.score,
          snippet: h.excerpt.split('\n').find((l) => l.trim()) ?? '',
          symbol: h.symbol?.name ?? null,
          indexStatus: result.indexStatus,
        })),
      };
    },
    inspectTask: async (taskId) => showTask(ctx, taskId) as unknown as Record<string, unknown>,
  };
}
