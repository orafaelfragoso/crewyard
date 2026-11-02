import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  type Actor,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  addSeconds,
  type Clock,
  canonicalPath,
  type FailureClass,
  hashToken,
  isExpired,
  isProcessAlive,
  isRailError,
  newId,
  newSecretToken,
  nowIso,
  type ProfileHealthStatus,
  type ProviderAdapter,
  RailError,
  SYSTEM_ACTOR,
  sleep,
  terminateTree,
  UNKNOWN_USAGE,
} from '@agent-rail/core';
import { createRedactor, parseRetryAfterSeconds, redactEvent } from '@agent-rail/provider-generic';
import { one, type RailContext } from '@agent-rail/storage';
import { type AgentRuntimeConfig, defaultAgentRuntimeConfig } from './config.ts';
import { type AgentDefinition, requireAgent } from './definitions.ts';
import { matchesRecordedProcess, processIdentity } from './process-identity.ts';
import { mapProfile, requireProfileRow, writeProfileHealth } from './profiles.ts';
import { createProviderRegistry, type ProviderRegistry, SESSION_MODES, type SessionMode } from './registry.ts';
import { routeAgentInDb } from './routing.ts';
import type { SecretStore } from './secrets.ts';
import {
  ACTIVE_SESSION_STATES,
  appendSessionEvent,
  closeUnsupervisedSession,
  getSession,
  latestSessionEventPayload,
  mapSession,
  type SessionRecord,
  sessionRow,
  sessionTransition,
  TERMINAL_SESSION_STATES,
} from './sessions.ts';
import { resolveCost } from './usage.ts';

export const DEFAULT_RATE_LIMIT_BACKOFF_SECONDS = 900;
const DEGRADED_AFTER_FAILURES = 3;
const MAX_LOG_EVENTS_PER_SESSION = 200;
const TOKEN_EXPIRY_SLACK_SECONDS = 60;

export interface LeaseBinding {
  projectId: string;
  taskId: string;
  leaseGeneration: number;
}

export interface StartSessionInput {
  agentId: string;
  taskId?: string | null;
  projectId?: string | null;
  cwd: string;
  prompt: string;
  mode: SessionMode;
  model?: string | null;
  leaseBinding?: LeaseBinding | null;
  workspaceId?: string | null;
  outputSchema?: Record<string, unknown>;
  timeoutMinutes?: number;
  actor?: Actor;
  claimToken?: string | null;
}

export interface StartedSession {
  sessionId: string;
  agentId: string;
  profileId: string;
  profileRef: string;
  providerId: string;
  model: string | null;
  pid: number | null;
  logPath: string;
  tokenExpiresAt: string;
  routing: string[];
}

export interface SupervisorOptions {
  config?: AgentRuntimeConfig;
  secrets?: SecretStore;
  registry?: ProviderRegistry;
  baseEnv?: NodeJS.ProcessEnv;
}

interface Supervised {
  adapter: ProviderAdapter;
  pid: number | null;
  finished: Promise<SessionRecord>;
}

interface SessionError {
  message: string;
  classification: FailureClass;
}

type SessionResult = Awaited<AgentSessionHandle['done']>;

const SUPERVISED = new Map<string, SessionSupervisor>();

export function isSupervisedInProcess(sessionId: string): boolean {
  return SUPERVISED.has(sessionId);
}

function resolveBinding(
  db: Database,
  clock: Clock,
  input: StartSessionInput,
  agent: AgentDefinition,
): { projectId: string | null; taskId: string | null; leaseGeneration: number | null } {
  const binding = input.leaseBinding ?? null;
  if (binding && input.taskId && input.taskId !== binding.taskId) {
    throw new RailError('INVALID_INPUT', 'taskId does not match the lease binding');
  }
  const taskId = binding?.taskId ?? input.taskId ?? null;
  let projectId = binding?.projectId ?? input.projectId ?? null;
  let leaseGeneration: number | null = null;
  if (projectId) {
    const project = one<{ id: string }>(db, 'SELECT id FROM projects WHERE id = ? OR name = ?', projectId, projectId);
    if (!project) throw new RailError('NOT_FOUND', `Project not found: ${projectId}`);
    projectId = project.id;
  }
  if (taskId) {
    const task = one<{ project_id: string }>(db, 'SELECT project_id FROM tasks WHERE id = ?', taskId);
    if (!task) throw new RailError('NOT_FOUND', `Task not found: ${taskId}`);
    if (projectId && projectId !== task.project_id) {
      throw new RailError('INVALID_INPUT', `Task ${taskId} does not belong to project ${projectId}`);
    }
    projectId = task.project_id;
    const lease = one<{ generation: number; expires_at: string }>(
      db,
      'SELECT generation, expires_at FROM leases WHERE task_id = ? AND released_at IS NULL',
      taskId,
    );
    if (!lease || isExpired(lease.expires_at, clock)) {
      throw new RailError('STALE_LEASE', `Task ${taskId} has no active lease`, {
        suggestion: 'Claim the task before starting a managed session for it.',
      });
    }
    if (binding && binding.leaseGeneration !== lease.generation) {
      throw new RailError('STALE_LEASE', `Lease generation ${binding.leaseGeneration} is no longer current`, {
        details: { current: lease.generation },
      });
    }
    leaseGeneration = lease.generation;
  }
  if (projectId && agent.projectIds.length > 0 && !agent.projectIds.includes(projectId)) {
    throw new RailError('NOT_AUTHORIZED', `Agent ${agent.name} is not a member of project ${projectId}`);
  }
  return { projectId, taskId, leaseGeneration };
}

export class SessionSupervisor {
  readonly config: AgentRuntimeConfig;
  readonly registry: ProviderRegistry;
  private readonly sessions = new Map<string, Supervised>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: RailContext,
    options: SupervisorOptions = {},
  ) {
    this.config = options.config ?? defaultAgentRuntimeConfig();
    this.registry =
      options.registry ??
      createProviderRegistry({
        cancelGraceMs: this.config.agents.cancel_grace_seconds * 1000,
        ...(options.secrets ? { secrets: options.secrets } : {}),
        ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
      });
  }

  supervising(): string[] {
    return [...this.sessions.keys()];
  }

  async start(input: StartSessionInput): Promise<StartedSession> {
    if (!SESSION_MODES.includes(input.mode)) throw new RailError('INVALID_INPUT', `Unknown mode ${input.mode}`);
    if (!input.prompt.trim()) throw new RailError('INVALID_INPUT', 'A prompt is required');
    const cwd = canonicalPath(input.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new RailError('INVALID_INPUT', `Working directory does not exist: ${input.cwd}`);
    }
    const actor = input.actor ?? SYSTEM_ACTOR;
    const sessionId = newId('ses');
    const logPath = join(this.ctx.dirs.logs, sessionId, 'session.log');
    const token = newSecretToken();
    const at = nowIso(this.ctx.clock);
    const graceSeconds = this.config.agents.cancel_grace_seconds;

    const prepared = this.ctx.store.immediate((db) => {
      const agent = requireAgent(db, input.agentId);
      if (!agent.managed) {
        throw new RailError('POLICY_DENIED', `Agent ${agent.name} is unmanaged; Agent Rail does not launch it`);
      }
      const binding = resolveBinding(db, this.ctx.clock, input, agent);
      const decision = routeAgentInDb(
        db,
        this.ctx.clock,
        {
          agentId: agent.id,
          taskId: binding.taskId,
          projectId: binding.projectId,
          requiredCapability: input.mode,
          model: input.model ?? null,
        },
        this.config,
      );
      const profile = mapProfile(requireProfileRow(db, decision.profileId));
      const timeoutMinutes =
        input.timeoutMinutes ?? agent.budget?.maxSessionMinutes ?? this.config.agents.session_timeout_minutes;
      const timeoutMs = Math.round(timeoutMinutes * 60_000);
      const expiresAt = addSeconds(at, Math.ceil(timeoutMs / 1000) + graceSeconds + TOKEN_EXPIRY_SLACK_SECONDS);
      db.query(
        `INSERT INTO sessions (id, agent_id, profile_id, provider_id, model, task_id, lease_generation, workspace_id, managed, mode, host, state, started_at, last_heartbeat_at, log_path, session_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'starting', ?, ?, ?, ?)`,
      ).run(
        sessionId,
        agent.id,
        profile.id,
        profile.providerId,
        decision.model,
        binding.taskId,
        binding.leaseGeneration,
        input.workspaceId ?? null,
        input.mode,
        hostname(),
        at,
        at,
        logPath,
        hashToken(token),
      );
      appendSessionEvent(
        db,
        sessionId,
        'session.routed',
        {
          profileId: profile.id,
          profileRef: decision.profileRef,
          model: decision.model,
          fallback: decision.fallback,
          explanation: decision.explanation,
        },
        at,
      );
      appendSessionEvent(
        db,
        sessionId,
        'token.issued',
        {
          projectId: binding.projectId,
          taskId: binding.taskId,
          leaseGeneration: binding.leaseGeneration,
          expiresAt,
        },
        at,
      );
      if (binding.taskId) {
        db.query(
          'UPDATE tasks SET selected_profile_id = ?, selected_model = ?, routing_explanation = ? WHERE id = ?',
        ).run(profile.id, decision.model, JSON.stringify(decision.explanation), binding.taskId);
      }
      sessionTransition(
        db,
        sessionRow(db, sessionId),
        'session.started',
        actor,
        {
          state: 'starting',
          agentId: agent.id,
          profileRef: decision.profileRef,
          providerId: profile.providerId,
          model: decision.model,
          mode: input.mode,
          fallback: decision.fallback,
        },
        at,
      );
      return { agent, profile, decision, binding, timeoutMs, expiresAt };
    });

    const { agent, profile, decision, binding } = prepared;
    const adapter = this.registry.get(profile.providerId);
    const launch: AgentLaunch = {
      sessionId,
      profile,
      model: decision.model,
      prompt: input.prompt,
      systemInstructions: agent.systemInstructions,
      cwd,
      env: {
        RAIL_SESSION_TOKEN: token,
        RAIL_SESSION_ID: sessionId,
        RAIL_AGENT_ID: agent.id,
        ...(binding.taskId ? { RAIL_TASK_ID: binding.taskId } : {}),
        ...(binding.projectId ? { RAIL_PROJECT_ID: binding.projectId } : {}),
        ...(input.claimToken && input.leaseBinding
          ? { RAIL_CLAIM_TOKEN: input.claimToken, RAIL_LEASE_GENERATION: String(input.leaseBinding.leaseGeneration) }
          : {}),
      },
      timeoutMs: prepared.timeoutMs,
      maxOutputBytes: agent.budget?.maxOutputBytes ?? this.config.agents.max_output_bytes,
      logPath,
      mode: input.mode,
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    };

    let handle: AgentSessionHandle;
    try {
      handle = await adapter.launch(launch);
    } catch (error) {
      this.recordLaunchFailure(sessionId, error, actor);
      throw error;
    }

    const startedAt = nowIso(this.ctx.clock);
    this.ctx.store.immediate((db) => {
      db.query(
        `UPDATE sessions SET pid = ?, last_heartbeat_at = ?, state = CASE WHEN state = 'starting' THEN 'running' ELSE state END WHERE id = ?`,
      ).run(handle.pid, startedAt, sessionId);
      appendSessionEvent(
        db,
        sessionId,
        'session.supervised',
        {
          supervisorPid: process.pid,
          host: hostname(),
          pid: handle.pid,
          processIdentity: handle.pid ? processIdentity(handle.pid) : null,
        },
        startedAt,
      );
    });

    SUPERVISED.set(sessionId, this);
    const finished = this.pump(sessionId, handle, token, actor);
    this.sessions.set(sessionId, { adapter, pid: handle.pid, finished });
    this.ensureHeartbeat();

    return {
      sessionId,
      agentId: agent.id,
      profileId: profile.id,
      profileRef: decision.profileRef,
      providerId: profile.providerId,
      model: decision.model,
      pid: handle.pid,
      logPath,
      tokenExpiresAt: prepared.expiresAt,
      routing: decision.explanation,
    };
  }

  async wait(sessionId: string): Promise<SessionRecord> {
    const supervised = this.sessions.get(sessionId);
    return supervised ? supervised.finished : getSession(this.ctx, sessionId);
  }

  async cancel(sessionId: string, input: { actor?: Actor; reason?: string } = {}): Promise<SessionRecord> {
    const supervised = this.sessions.get(sessionId);
    if (!supervised) return stopSession(this.ctx, sessionId, input);
    const actor = input.actor ?? SYSTEM_ACTOR;
    const at = nowIso(this.ctx.clock);
    this.ctx.store.immediate((db) => {
      const row = sessionRow(db, sessionId);
      if (row.state !== 'starting' && row.state !== 'running') return;
      db.query(`UPDATE sessions SET state = 'stopping' WHERE id = ?`).run(sessionId);
      appendSessionEvent(db, sessionId, 'session.stopping', { reason: input.reason ?? 'operator request' }, at);
      sessionTransition(db, row, 'session.stopping', actor, { state: 'stopping', reason: input.reason ?? null }, at);
    });
    await supervised.adapter.cancel(sessionId);
    if (supervised.pid && isProcessAlive(supervised.pid)) await terminateTree(supervised.pid, 0);
    return supervised.finished;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (this.sessions.size === 0) return;
      const at = nowIso(this.ctx.clock);
      try {
        this.ctx.store.immediate((db) => {
          for (const id of this.sessions.keys()) {
            db.query(
              `UPDATE sessions SET last_heartbeat_at = ? WHERE id = ? AND state IN ('starting', 'running', 'stopping')`,
            ).run(at, id);
          }
        });
      } catch (error) {
        this.ctx.logger.warn('session heartbeat failed', { error: (error as Error).message });
      }
    }, this.config.agents.heartbeat_interval_seconds * 1000);
    this.heartbeat.unref?.();
  }

  private releaseHeartbeat(): void {
    if (this.sessions.size > 0 || !this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async pump(
    sessionId: string,
    handle: AgentSessionHandle,
    token: string,
    actor: Actor,
  ): Promise<SessionRecord> {
    const scrub = createRedactor([token]);
    let lastError: SessionError | null = null;
    let logEvents = 0;
    try {
      for await (const raw of handle.events) {
        const event = redactEvent(raw, scrub);
        if (event.type === 'error') lastError = { message: event.message, classification: event.classification };
        if (event.type === 'log') {
          logEvents++;
          if (logEvents > MAX_LOG_EVENTS_PER_SESSION) continue;
        }
        this.persistEvent(sessionId, event, logEvents === MAX_LOG_EVENTS_PER_SESSION && event.type === 'log');
      }
    } catch (error) {
      this.ctx.logger.warn('session event stream failed', { sessionId, error: (error as Error).message });
    }
    let result: SessionResult;
    try {
      result = await handle.done;
    } catch (error) {
      lastError ??= { message: scrub((error as Error).message), classification: 'unknown' };
      result = { outcome: 'failed', exitCode: null, usage: UNKNOWN_USAGE, result: null };
    }
    try {
      return this.finalize(sessionId, result, lastError, actor);
    } finally {
      this.sessions.delete(sessionId);
      SUPERVISED.delete(sessionId);
      this.releaseHeartbeat();
    }
  }

  private persistEvent(sessionId: string, event: AgentEvent, lastLogEvent: boolean): void {
    const { type, ...payload } = event;
    const at = nowIso(this.ctx.clock);
    try {
      this.ctx.store.immediate((db) => {
        appendSessionEvent(db, sessionId, `agent.${type}`, payload, at);
        if (lastLogEvent) {
          appendSessionEvent(
            db,
            sessionId,
            'session.log_events_capped',
            { limit: MAX_LOG_EVENTS_PER_SESSION, detail: 'further log lines are only in the session log file' },
            at,
          );
        }
        if (event.type === 'started' && event.providerSessionId) {
          db.query('UPDATE sessions SET provider_session_id = ?, last_heartbeat_at = ? WHERE id = ?').run(
            event.providerSessionId,
            at,
            sessionId,
          );
        } else {
          db.query('UPDATE sessions SET last_heartbeat_at = ? WHERE id = ?').run(at, sessionId);
        }
      });
    } catch (error) {
      this.ctx.logger.warn('failed to persist session event', { sessionId, error: (error as Error).message });
    }
  }

  private finalize(
    sessionId: string,
    result: SessionResult,
    lastError: SessionError | null,
    actor: Actor,
  ): SessionRecord {
    const at = nowIso(this.ctx.clock);
    return this.ctx.store.immediate((db) => {
      const row = sessionRow(db, sessionId);
      if (TERMINAL_SESSION_STATES.includes(row.state)) return mapSession(row);
      const outcome = row.state === 'stopping' && result.outcome !== 'succeeded' ? 'cancelled' : result.outcome;
      const state = outcome === 'succeeded' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'failed';
      const errorReason =
        outcome === 'succeeded'
          ? null
          : outcome === 'cancelled'
            ? 'cancelled: session stopped by request'
            : `${outcome === 'timed_out' ? 'timed_out' : (lastError?.classification ?? 'unknown')}: ${
                lastError?.message ?? `process exited with ${result.exitCode ?? 'a signal'}`
              }`.slice(0, 1_000);
      db.query(
        `UPDATE sessions SET state = ?, ended_at = ?, exit_code = ?, outcome = ?, error_reason = ?, last_heartbeat_at = ?, session_token_hash = NULL WHERE id = ?`,
      ).run(state, at, result.exitCode, outcome, errorReason, at, sessionId);
      const cost = resolveCost(result.usage, row.provider_id, row.model, this.config.observability.rates);
      db.query(
        `INSERT INTO session_usage (session_id, provider_id, profile_id, model, input_tokens, output_tokens, cached_tokens, cost_usd, usage_source, cost_source, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        row.provider_id,
        row.profile_id,
        result.usage.model ?? row.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cachedTokens,
        cost.costUsd,
        result.usage.usageSource,
        cost.costSource,
        at,
      );
      if (row.profile_id) this.applyHealth(db, row.profile_id, outcome, lastError, at);
      appendSessionEvent(
        db,
        sessionId,
        'session.ended',
        {
          state,
          outcome,
          exitCode: result.exitCode,
          usageSource: result.usage.usageSource,
          costSource: cost.costSource,
        },
        at,
      );
      sessionTransition(
        db,
        row,
        `session.${state}`,
        actor,
        { state, outcome, exitCode: result.exitCode, errorReason },
        at,
      );
      return mapSession(sessionRow(db, sessionId));
    });
  }

  private applyHealth(
    db: Database,
    profileId: string,
    outcome: SessionResult['outcome'],
    error: SessionError | null,
    at: string,
  ): void {
    if (outcome === 'succeeded') {
      writeProfileHealth(
        db,
        profileId,
        { status: 'healthy', detail: 'last session succeeded', success: true, rateLimitedUntil: null },
        at,
      );
      return;
    }
    if (outcome !== 'failed' || !error) return;
    const current = one<{ status: ProfileHealthStatus; consecutive_failures: number }>(
      db,
      'SELECT status, consecutive_failures FROM provider_health WHERE profile_id = ?',
      profileId,
    );
    switch (error.classification) {
      case 'rate_limited': {
        const seconds = parseRetryAfterSeconds(error.message) ?? DEFAULT_RATE_LIMIT_BACKOFF_SECONDS;
        writeProfileHealth(
          db,
          profileId,
          {
            status: 'rate_limited',
            detail: 'provider reported a rate limit',
            rateLimitedUntil: addSeconds(at, seconds),
            failure: true,
            lastError: error.message,
          },
          at,
        );
        return;
      }
      case 'authentication':
        writeProfileHealth(
          db,
          profileId,
          {
            status: 'unauthenticated',
            detail: 'provider rejected the credentials',
            failure: true,
            lastError: error.message,
          },
          at,
        );
        return;
      case 'transient_provider':
      case 'transient_network': {
        const failures = (current?.consecutive_failures ?? 0) + 1;
        writeProfileHealth(
          db,
          profileId,
          {
            status: failures >= DEGRADED_AFTER_FAILURES ? 'degraded' : (current?.status ?? 'unknown'),
            detail: `${failures} consecutive transient failure(s)`,
            failure: true,
            lastError: error.message,
          },
          at,
        );
        return;
      }
      default:
        return;
    }
  }

  private recordLaunchFailure(sessionId: string, error: unknown, actor: Actor): void {
    const at = nowIso(this.ctx.clock);
    const message = error instanceof Error ? error.message : String(error);
    const code = isRailError(error) ? error.code : 'INTERNAL';
    this.ctx.store.immediate((db) => {
      const row = sessionRow(db, sessionId);
      db.query(
        `UPDATE sessions SET state = 'failed', ended_at = ?, outcome = 'failed', error_reason = ?, session_token_hash = NULL WHERE id = ?`,
      ).run(at, `launch_failed: ${code}: ${message}`.slice(0, 1_000), sessionId);
      if (row.profile_id && (code === 'UNAUTHENTICATED' || code === 'UNAVAILABLE')) {
        writeProfileHealth(
          db,
          row.profile_id,
          {
            status: code === 'UNAUTHENTICATED' ? 'unauthenticated' : 'unavailable',
            detail: message,
            failure: true,
            lastError: message,
          },
          at,
        );
      }
      appendSessionEvent(db, sessionId, 'session.launch_failed', { code, message }, at);
      sessionTransition(db, row, 'session.failed', actor, { state: 'failed', code, message }, at);
    });
  }
}

const DEFAULT_SUPERVISORS = new WeakMap<RailContext, SessionSupervisor>();

export function sessionSupervisor(ctx: RailContext, options: SupervisorOptions = {}): SessionSupervisor {
  let supervisor = DEFAULT_SUPERVISORS.get(ctx);
  if (!supervisor) {
    supervisor = new SessionSupervisor(ctx, options);
    DEFAULT_SUPERVISORS.set(ctx, supervisor);
  }
  return supervisor;
}

export function startManagedSession(
  ctx: RailContext,
  input: StartSessionInput,
  options: SupervisorOptions = {},
): Promise<StartedSession> {
  return sessionSupervisor(ctx, options).start(input);
}

export async function awaitSession(
  ctx: RailContext,
  sessionId: string,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<SessionRecord> {
  const supervisor = SUPERVISED.get(sessionId);
  if (supervisor) return supervisor.wait(sessionId);
  const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  for (;;) {
    const session = getSession(ctx, sessionId);
    if (TERMINAL_SESSION_STATES.includes(session.state)) return session;
    const local = SUPERVISED.get(sessionId);
    if (local) return local.wait(sessionId);
    if (Date.now() >= deadline) {
      throw new RailError('BUSY', `Session ${sessionId} is still ${session.state}`, { retryable: true });
    }
    await sleep(options.pollMs ?? 500);
  }
}

export async function stopSession(
  ctx: RailContext,
  sessionId: string,
  input: { actor?: Actor; reason?: string; graceMs?: number } = {},
): Promise<SessionRecord> {
  const supervisor = SUPERVISED.get(sessionId);
  if (supervisor) return supervisor.cancel(sessionId, input);
  const actor = input.actor ?? SYSTEM_ACTOR;
  const session = getSession(ctx, sessionId);
  if (TERMINAL_SESSION_STATES.includes(session.state)) return session;
  if (!session.managed) {
    throw new RailError('UNSUPPORTED_CAPABILITY', 'Unmanaged sessions cannot be cancelled by Agent Rail');
  }
  if (session.host && session.host !== hostname()) {
    throw new RailError('UNSUPPORTED_CAPABILITY', `Session ${sessionId} runs on host ${session.host}`);
  }
  const at = nowIso(ctx.clock);
  const supervision = ctx.store.immediate((db) => {
    const row = sessionRow(db, sessionId);
    if (ACTIVE_SESSION_STATES.includes(row.state) && row.state !== 'stopping') {
      db.query(`UPDATE sessions SET state = 'stopping' WHERE id = ?`).run(sessionId);
      appendSessionEvent(db, sessionId, 'session.stopping', { reason: input.reason ?? 'operator request' }, at);
    }
    return latestSessionEventPayload(db, sessionId, 'session.supervised');
  });
  const graceMs = input.graceMs ?? defaultAgentRuntimeConfig().agents.cancel_grace_seconds * 1000;
  if (session.pid && isProcessAlive(session.pid) && matchesRecordedProcess(session.pid, supervision?.processIdentity)) {
    await terminateTree(session.pid, graceMs);
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const current = getSession(ctx, sessionId);
    if (TERMINAL_SESSION_STATES.includes(current.state)) return current;
    if (!isLiveSupervisor(supervision?.supervisorPid)) break;
    await sleep(100);
  }
  return ctx.store.immediate(
    (db) =>
      closeUnsupervisedSession(
        db,
        sessionId,
        'cancelled',
        'cancelled: stopped without a live supervisor',
        actor,
        nowIso(ctx.clock),
      ) ?? mapSession(sessionRow(db, sessionId)),
  );
}

export function isLiveSupervisor(supervisorPid: unknown): boolean {
  return typeof supervisorPid === 'number' && supervisorPid !== process.pid && isProcessAlive(supervisorPid);
}
