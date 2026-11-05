import { hostname } from 'node:os';
import { type AgentDefinition, listAgents, listSessions, reapOrphans } from '@crewyard/agents';
import { type Actor, nowIso, toCrewError } from '@crewyard/core';
import { listProjects, loadProjectConfig, primaryRepository, recordPolicyRevision } from '@crewyard/projects';
import { type RemoteRecovery, reconcileLeases, runRecovery } from '@crewyard/recovery';
import { planDispatch } from '@crewyard/scheduler';
import {
  acquireLeadership,
  appendEvent,
  type CrewContext,
  heartbeatWorker,
  registerWorker,
  releaseLeadership,
  unregisterWorker,
} from '@crewyard/storage';
import { showTask } from '@crewyard/tasks';
import { recordOperation } from '@crewyard/telemetry';
import { freeDiskBytes } from '@crewyard/workspaces';
import { type Dispatch, dispatchTask, prepareDispatchExecution } from './agents.ts';
import { guardDiskSpace } from './disk-guard.ts';
import {
  DEFAULT_EXECUTION_LIMITS,
  type ExecutionLimits,
  type ExecutionOperation,
  submitExecution,
} from './execution.ts';
import { ExecutionSupervisor } from './execution-supervisor.ts';
import { prepareQueueExecution } from './integration.ts';
import { buildIndex, indexState, prepareIndexExecution } from './retrieval.ts';

export interface ProjectCycle {
  name: string;
  intervalSeconds(ctx: CrewContext, projectId: string): number;
  run(
    ctx: CrewContext,
    input: {
      projectId: string;
      leaderId: string;
      leaderGeneration: number;
      background(work: Promise<unknown>): void;
    },
  ): Promise<Record<string, unknown>>;
}

export interface ServiceOptions {
  cycles?: readonly ProjectCycle[];
  remoteRecovery?: readonly RemoteRecovery[];
  tickSeconds?: number;
  dispatch?: boolean;
  execution?: ExecutionLimits;
  freeDiskBytes?: (path: string) => number;
}

const SERVICE_ACTOR: Actor = { kind: 'service', id: `crew-service@${hostname()}` };
const HEARTBEAT_MS = 30_000;

export function selectAgentForTask(ctx: CrewContext, taskId: string): AgentDefinition | null {
  const task = showTask(ctx, taskId).task;
  const agents = listAgents(ctx, { managed: true });
  const running = new Map<string, number>();
  for (const s of listSessions(ctx, { limit: 1000 })) {
    if (s.agentId && ['starting', 'running', 'stopping'].includes(s.state))
      running.set(s.agentId, (running.get(s.agentId) ?? 0) + 1);
  }
  const pending = ctx.store.db
    .query(`SELECT json_extract(intent, '$.operation.agentId') AS agent_id, json_extract(intent, '$.operation.taskId') AS task_id
    FROM outbox WHERE kind = 'execution.launch' AND status IN ('pending', 'attempted', 'ambiguous') AND json_extract(intent, '$.operation.kind') = 'dispatch'`)
    .all() as { agent_id: string; task_id: string }[];
  const sessions = listSessions(ctx, { limit: 1000 });
  for (const item of pending) {
    if (
      !sessions.some(
        (session) => session.taskId === item.task_id && ['starting', 'running', 'stopping'].includes(session.state),
      )
    )
      running.set(item.agent_id, (running.get(item.agent_id) ?? 0) + 1);
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

export class CrewService {
  readonly workerId: string;
  private stopping = false;
  private stopped: Promise<void> | null = null;
  private readonly lastRun = new Map<string, number>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly dispatches = new Set<Dispatch>();
  private readonly leaders = new Map<string, number>();
  private readonly leaderTtls = new Map<string, number>();
  private readonly executions: ExecutionSupervisor | null;
  private pulse: ReturnType<typeof setInterval> | null = null;
  private projectCursor = 0;

  constructor(
    private readonly ctx: CrewContext,
    private readonly options: ServiceOptions = {},
  ) {
    this.workerId = registerWorker(ctx.store, 'service', { pid: process.pid, host: hostname() });
    this.executions =
      options.cycles === undefined
        ? new ExecutionSupervisor(ctx, this.workerId, options.execution ?? { ...DEFAULT_EXECUTION_LIMITS })
        : null;
  }

  log(type: string, payload: Record<string, unknown>, projectId: string | null = null): void {
    this.ctx.store.immediate((db) => appendEvent(db, { type, actor: SERVICE_ACTOR, projectId, payload }));
  }

  async start(): Promise<void> {
    const recovery = this.executions
      ? null
      : await runRecovery(this.ctx, { actor: SERVICE_ACTOR, remote: this.options.remoteRecovery ?? [] });
    this.log('service.started', {
      workerId: this.workerId,
      ...(recovery
        ? { recoveryState: 'completed', recoveryOk: recovery.ok }
        : { recoveryState: 'deferred_to_workers' }),
    });
    const beat = () =>
      heartbeatWorker(this.ctx.store, this.workerId, 'running', {
        inflight: this.inflight.size,
        at: nowIso(this.ctx.clock),
      });
    const pulse = setInterval(beat, HEARTBEAT_MS);
    try {
      while (!this.stopping) {
        const started = Date.now();
        await this.tick().catch((error: unknown) =>
          this.log('service.tick_failed', { error: toCrewError(error).message }),
        );
        beat();
        const wait = (this.options.tickSeconds ?? 15) * 1000 - (Date.now() - started);
        for (let waited = 0; waited < wait && !this.stopping; waited += 250)
          await Bun.sleep(Math.min(250, wait - waited));
      }
    } finally {
      clearInterval(pulse);
    }
    await this.stopped;
  }

  stop(): Promise<void> {
    this.stopped ??= this.shutdown();
    return this.stopped;
  }

  private async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.pulse) clearInterval(this.pulse);
    await this.executions?.stop();
    await Promise.allSettled([...this.dispatches].map((d) => d.interrupt('the Crewyard service stopped')));
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

  private track(name: string, projectId: string, work: Promise<unknown>): void {
    const done = work
      .catch((error: unknown) => this.log(`service.${name}_failed`, { error: toCrewError(error).message }, projectId))
      .finally(() => this.inflight.delete(done));
    this.inflight.add(done);
  }

  async tick(): Promise<void> {
    const started = performance.now();
    if (this.executions && !this.pulse) {
      this.pulse = setInterval(() => {
        try {
          for (const [scope, ttl] of this.leaderTtls) {
            const lease = acquireLeadership(this.ctx.store, scope, this.workerId, ttl);
            if (lease) this.leaders.set(scope, lease.generation);
            else this.leaders.delete(scope);
          }
          heartbeatWorker(this.ctx.store, this.workerId, 'running', { executions: this.executions?.size ?? 0 });
          this.executions?.pump();
        } catch (error) {
          this.ctx.logger.error('service pulse failed', { error: toCrewError(error).message });
        }
      }, 1_000);
    }
    if (!this.executions) await reapOrphans(this.ctx, { actor: SERVICE_ACTOR });
    const projects = listProjects(this.ctx);
    const offset = projects.length ? this.projectCursor++ % projects.length : 0;
    for (const project of [...projects.slice(offset), ...projects.slice(0, offset)]) {
      if (this.stopping) return;
      try {
        await this.projectTick(project.id, project.workersPaused, project.intakePaused);
      } catch (error) {
        this.log('service.project_failed', { error: toCrewError(error).message }, project.id);
      }
    }
    this.executions?.pump();
    if (this.executions)
      recordOperation(this.ctx, {
        operation: 'controller',
        projectId: null,
        repositoryId: null,
        durationMs: performance.now() - started,
        outcome: 'completed',
        actor: SERVICE_ACTOR,
        counts: { projects: projects.length, activeWorkers: this.executions.size },
      });
  }

  private async projectTick(projectId: string, workersPaused: boolean, intakePaused: boolean): Promise<void> {
    const loaded = loadProjectConfig(this.ctx, projectId);
    recordPolicyRevision(this.ctx, projectId, loaded.config, SERVICE_ACTOR.id);
    if (this.executions) {
      await this.projectExecutionTick(projectId, workersPaused, intakePaused);
      return;
    }
    await reconcileLeases(this.ctx, { projectId, actor: SERVICE_ACTOR });
    const repo = primaryRepository(this.ctx, projectId);

    if (loaded.config.index.enabled && this.due(`index:${projectId}`, 300)) {
      const status = await indexState(this.ctx, { projectId }).catch(() => null);
      if (status && status.status !== 'fresh' && status.status !== 'building') {
        await buildIndex(this.ctx, { projectId, actor: SERVICE_ACTOR }).catch((error: unknown) =>
          this.log('service.index_failed', { error: toCrewError(error).message }, projectId),
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
          background: (work) => this.track(cycle.name, projectId, work),
        });
        if (Object.keys(result).length > 0) this.log(`service.${cycle.name}`, result, projectId);
      } catch (error) {
        this.log(`service.${cycle.name}_failed`, { error: toCrewError(error).message }, projectId);
      }
    }

    if (workersPaused || intakePaused || this.options.dispatch === false) return;
    if (loaded.config.project.autonomy === 'observe') return;
    const guard = await guardDiskSpace(this.ctx, {
      projectId,
      config: loaded.config,
      actor: SERVICE_ACTOR,
      alert: true,
      prune: 'when-low',
      ...(this.options.freeDiskBytes ? { measure: this.options.freeDiskBytes } : {}),
    });
    const plan = planDispatch(this.ctx, projectId, { config: loaded.config, freeDiskBytes: guard.freeDiskBytes });
    for (const admission of plan.admitted) {
      if (this.stopping) return;
      const agent = selectAgentForTask(this.ctx, admission.taskId);
      if (!agent) continue;
      try {
        const dispatch = await dispatchTask(this.ctx, {
          taskId: admission.taskId,
          agent: agent.id,
          actor: SERVICE_ACTOR,
          inProcess: true,
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
              { taskId: admission.taskId, error: toCrewError(error).message },
              projectId,
            ),
          )
          .finally(() => {
            this.inflight.delete(done);
            this.dispatches.delete(dispatch);
          });
        this.inflight.add(done);
        this.dispatches.add(dispatch);
        if (this.stopping) void dispatch.interrupt('the Crewyard service stopped');
      } catch (error) {
        this.log(
          'service.dispatch_failed',
          { taskId: admission.taskId, agentId: agent.id, error: toCrewError(error).message },
          projectId,
        );
      }
    }
  }
  private async projectExecutionTick(projectId: string, workersPaused: boolean, intakePaused: boolean): Promise<void> {
    const loaded = loadProjectConfig(this.ctx, projectId);
    const repo = primaryRepository(this.ctx, projectId);
    const scope = `integration:${repo.id}:${repo.defaultBase}`;
    const ttl = Math.max(60, loaded.config.integration.poll_interval_seconds * 3);
    const lease = acquireLeadership(this.ctx.store, scope, this.workerId, ttl);
    if (!lease) {
      this.leaders.delete(scope);
      this.leaderTtls.delete(scope);
      return;
    }
    this.leaders.set(scope, lease.generation);
    this.leaderTtls.set(scope, ttl);
    const cycles: { operation: ExecutionOperation; seconds: number }[] = [];
    const schedule = (operation: ExecutionOperation, seconds: number) => cycles.push({ operation, seconds });
    if (repo.remoteOwner !== null && (repo.remoteHost === 'github.com' || Boolean(process.env.CREW_GITHUB_API_URL))) {
      schedule({ kind: 'sync' }, loaded.config.integration.poll_interval_seconds);
      schedule({ kind: 'publish' }, 5);
      schedule({ kind: 'outbox' }, 5);
      schedule(prepareQueueExecution(this.ctx, repo.id, { sync: false, maxCandidates: 3, processOutbox: false }), 5);
      schedule({ kind: 'health' }, 30);
    }
    if (loaded.config.index.enabled && Date.now() - (this.lastRun.get(`index:${projectId}`) ?? 0) >= 300_000)
      schedule(await prepareIndexExecution(this.ctx, { projectId }), 300);
    schedule({ kind: 'cleanup' }, 30);
    if (
      !workersPaused &&
      !intakePaused &&
      this.options.dispatch !== false &&
      loaded.config.project.autonomy !== 'observe'
    ) {
      const plan = planDispatch(this.ctx, projectId, {
        config: loaded.config,
        freeDiskBytes:
          loaded.config.scheduler.min_free_disk_gb === 0
            ? null
            : (this.options.freeDiskBytes ?? freeDiskBytes)(this.ctx.dirs.worktrees),
      });
      for (const admission of plan.admitted) {
        const agent = selectAgentForTask(this.ctx, admission.taskId);
        if (agent)
          schedule(
            prepareDispatchExecution(this.ctx, { taskId: admission.taskId, agent: agent.id, actor: SERVICE_ACTOR }),
            5,
          );
      }
    }
    const keyFor = (operation: ExecutionOperation) =>
      `${operation.kind}:${projectId}${operation.kind === 'dispatch' ? `:${operation.taskId}` : ''}`;
    cycles.sort((a, b) => (this.lastRun.get(keyFor(a.operation)) ?? 0) - (this.lastRun.get(keyFor(b.operation)) ?? 0));
    for (const { operation, seconds } of cycles) {
      if (this.stopping) return;
      const key = keyFor(operation);
      if (Date.now() - (this.lastRun.get(key) ?? 0) < seconds * 1000) continue;
      const admitted = submitExecution(
        this.ctx,
        {
          projectId,
          repositoryId: repo.id,
          actor: SERVICE_ACTOR,
          leaderId: this.workerId,
          operation,
        },
        this.executions!.limits,
      );
      if (admitted) this.lastRun.set(key, Date.now());
    }
  }
}
