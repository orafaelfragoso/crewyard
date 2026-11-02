import { hostname } from 'node:os';
import { type AgentDefinition, listAgents, listSessions, reapOrphans } from '@agent-rail/agents';
import { type Actor, nowIso, toRailError } from '@agent-rail/core';
import { listProjects, loadProjectConfig, primaryRepository, recordPolicyRevision } from '@agent-rail/projects';
import { type RemoteRecovery, reconcileLeases, runRecovery } from '@agent-rail/recovery';
import { planDispatch } from '@agent-rail/scheduler';
import {
  acquireLeadership,
  appendEvent,
  heartbeatWorker,
  type RailContext,
  registerWorker,
  releaseLeadership,
  unregisterWorker,
} from '@agent-rail/storage';
import { showTask } from '@agent-rail/tasks';
import { dispatchTask } from './agents.ts';
import { buildIndex, indexState } from './retrieval.ts';

export interface ProjectCycle {
  name: string;
  intervalSeconds(ctx: RailContext, projectId: string): number;
  run(
    ctx: RailContext,
    input: { projectId: string; leaderId: string; leaderGeneration: number },
  ): Promise<Record<string, unknown>>;
}

export interface ServiceOptions {
  cycles?: readonly ProjectCycle[];
  remoteRecovery?: readonly RemoteRecovery[];
  tickSeconds?: number;
  dispatch?: boolean;
}

const SERVICE_ACTOR: Actor = { kind: 'service', id: `rail-service@${hostname()}` };

export function selectAgentForTask(ctx: RailContext, taskId: string): AgentDefinition | null {
  const task = showTask(ctx, taskId).task;
  const agents = listAgents(ctx, { managed: true });
  const running = new Map<string, number>();
  for (const s of listSessions(ctx, { limit: 1000 })) {
    if (s.agentId && ['starting', 'running', 'stopping'].includes(s.state))
      running.set(s.agentId, (running.get(s.agentId) ?? 0) + 1);
  }
  const hasCapacity = (a: AgentDefinition) => (running.get(a.id) ?? 0) < a.maxParallel;
  if (task.assignedAgentId) {
    const assigned = agents.find((a) => a.id === task.assignedAgentId);
    return assigned && hasCapacity(assigned) ? assigned : null;
  }
  const role = task.requestedRole ?? 'engineer';
  return (
    agents
      .filter((a) => a.projectIds.length === 0 || a.projectIds.includes(task.projectId))
      .filter((a) => a.role === role)
      .filter(hasCapacity)
      .sort((a, b) => (running.get(a.id) ?? 0) - (running.get(b.id) ?? 0) || a.name.localeCompare(b.name))[0] ?? null
  );
}

export class RailService {
  readonly workerId: string;
  private stopping = false;
  private readonly lastRun = new Map<string, number>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly leaders = new Map<string, number>();

  constructor(
    private readonly ctx: RailContext,
    private readonly options: ServiceOptions = {},
  ) {
    this.workerId = registerWorker(ctx.store, 'service', { pid: process.pid, host: hostname() });
  }

  log(type: string, payload: Record<string, unknown>, projectId: string | null = null): void {
    this.ctx.store.immediate((db) => appendEvent(db, { type, actor: SERVICE_ACTOR, projectId, payload }));
  }

  async start(): Promise<void> {
    const recovery = await runRecovery(this.ctx, { actor: SERVICE_ACTOR, remote: this.options.remoteRecovery ?? [] });
    this.log('service.started', { workerId: this.workerId, recoveryOk: recovery.ok });
    while (!this.stopping) {
      const started = Date.now();
      await this.tick().catch((error: unknown) =>
        this.log('service.tick_failed', { error: toRailError(error).message }),
      );
      heartbeatWorker(this.ctx.store, this.workerId, 'running', {
        inflight: this.inflight.size,
        at: nowIso(this.ctx.clock),
      });
      const wait = (this.options.tickSeconds ?? 15) * 1000 - (Date.now() - started);
      for (let waited = 0; waited < wait && !this.stopping; waited += 250)
        await Bun.sleep(Math.min(250, wait - waited));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inflight]);
    for (const [scope, generation] of this.leaders) releaseLeadership(this.ctx.store, scope, this.workerId, generation);
    unregisterWorker(this.ctx.store, this.workerId);
    this.log('service.stopped', { workerId: this.workerId });
  }

  private due(key: string, seconds: number): boolean {
    const last = this.lastRun.get(key) ?? 0;
    if (Date.now() - last < seconds * 1000) return false;
    this.lastRun.set(key, Date.now());
    return true;
  }

  async tick(): Promise<void> {
    await reapOrphans(this.ctx, { actor: SERVICE_ACTOR });
    for (const project of listProjects(this.ctx)) {
      if (this.stopping) return;
      try {
        await this.projectTick(project.id, project.workersPaused, project.intakePaused);
      } catch (error) {
        this.log('service.project_failed', { error: toRailError(error).message }, project.id);
      }
    }
  }

  private async projectTick(projectId: string, workersPaused: boolean, intakePaused: boolean): Promise<void> {
    const loaded = loadProjectConfig(this.ctx, projectId);
    recordPolicyRevision(this.ctx, projectId, loaded.config, SERVICE_ACTOR.id);
    await reconcileLeases(this.ctx, { projectId, actor: SERVICE_ACTOR });
    const repo = primaryRepository(this.ctx, projectId);

    if (loaded.config.index.enabled && this.due(`index:${projectId}`, 300)) {
      const status = await indexState(this.ctx, { projectId }).catch(() => null);
      if (status && status.status !== 'fresh' && status.status !== 'building') {
        await buildIndex(this.ctx, { projectId, actor: SERVICE_ACTOR }).catch((error: unknown) =>
          this.log('service.index_failed', { error: toRailError(error).message }, projectId),
        );
      }
    }

    const scope = `integration:${repo.id}:${repo.defaultBase}`;
    const lease = acquireLeadership(
      this.ctx.store,
      scope,
      this.workerId,
      Math.max(60, loaded.config.integration.poll_interval_seconds * 3),
    );
    if (lease) this.leaders.set(scope, lease.generation);
    else this.leaders.delete(scope);

    for (const cycle of this.options.cycles ?? []) {
      if (!lease || !this.due(`${cycle.name}:${projectId}`, cycle.intervalSeconds(this.ctx, projectId))) continue;
      try {
        const result = await cycle.run(this.ctx, {
          projectId,
          leaderId: this.workerId,
          leaderGeneration: lease.generation,
        });
        if (Object.keys(result).length > 0) this.log(`service.${cycle.name}`, result, projectId);
      } catch (error) {
        this.log(`service.${cycle.name}_failed`, { error: toRailError(error).message }, projectId);
      }
    }

    if (workersPaused || intakePaused || this.options.dispatch === false) return;
    if (loaded.config.project.autonomy === 'observe') return;
    const plan = planDispatch(this.ctx, projectId, { config: loaded.config });
    for (const admission of plan.admitted) {
      const agent = selectAgentForTask(this.ctx, admission.taskId);
      if (!agent) continue;
      try {
        const dispatch = await dispatchTask(this.ctx, {
          taskId: admission.taskId,
          agent: agent.id,
          actor: SERVICE_ACTOR,
        });
        this.log(
          'service.dispatched',
          { taskId: admission.taskId, agentId: agent.id, sessionId: dispatch.session.sessionId },
          projectId,
        );
        const done = dispatch.done
          .then((outcome) => this.log('service.dispatch_finished', { taskId: admission.taskId, outcome }, projectId))
          .catch((error: unknown) =>
            this.log(
              'service.dispatch_failed',
              { taskId: admission.taskId, error: toRailError(error).message },
              projectId,
            ),
          )
          .finally(() => this.inflight.delete(done));
        this.inflight.add(done);
      } catch (error) {
        this.log(
          'service.dispatch_failed',
          { taskId: admission.taskId, agentId: agent.id, error: toRailError(error).message },
          projectId,
        );
      }
    }
  }
}
