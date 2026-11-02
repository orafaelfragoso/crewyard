import { type HandoffKind, RailError, type TaskState } from '@agent-rail/core';
import { getProject, loadProjectConfig, primaryRepository } from '@agent-rail/projects';
import type { RailContext } from '@agent-rail/storage';
import {
  getNextAction,
  heartbeat,
  listTasks,
  report,
  reportProgress,
  showTask,
  type TestEvidence,
} from '@agent-rail/tasks';
import { overviewProjection } from '@agent-rail/telemetry';
import {
  type AgentTool,
  assertToolAllowed,
  type Caller,
  callerActor,
  callerAgentId,
  callerProject,
  leaseFor,
} from './caller.ts';
import { serviceStatus } from './service-control.ts';
import { claimAndPrepare, type PreparedClaim } from './work.ts';

export function authorize(caller: Caller, tool: AgentTool, projectId?: string | null): string {
  assertToolAllowed(caller, tool);
  return callerProject(caller, projectId);
}

export function agentState(ctx: RailContext, caller: Caller, projectId?: string | null) {
  const pid = authorize(caller, 'rail_get_state', projectId);
  const project = getProject(ctx, pid);
  const repo = primaryRepository(ctx, pid);
  const config = loadProjectConfig(ctx, pid).config;
  const overview = overviewProjection(ctx, pid);
  const service = serviceStatus(ctx);
  return {
    project: {
      id: project.id,
      name: project.name,
      autonomy: project.autonomy,
      intakePaused: project.intakePaused,
      workersPaused: project.workersPaused,
      policyRevision: project.policyRevision,
      repository: {
        id: repo.id,
        baseBranch: repo.defaultBase,
        remote: repo.remoteOwner ? `${repo.remoteOwner}/${repo.remoteName}` : null,
      },
    },
    policy: {
      leaseSeconds: config.agents.default_task_lease_seconds,
      heartbeatIntervalSeconds: config.agents.heartbeat_interval_seconds,
      maxRetriesPerFailure: config.agents.max_retries_per_failure,
      rebasing: config.integration.rebasing,
      approvalRequiredFor: config.security.require_approval_for,
      mergeAuthority:
        'Agents never merge. Integration goes through rail_request_integration and GitHub branch protections.',
    },
    tasks: overview.tasksByState,
    queue: { queued: overview.queued, openPrs: overview.openPrs, mergedLast24h: overview.mergedLast24h },
    workers: { serviceRunning: service.running, note: service.note, runningSessions: overview.runningSessions },
    caller: {
      kind: caller.kind,
      agentId: callerAgentId(caller),
      ...(caller.kind === 'session'
        ? { sessionId: caller.sessionId, taskId: caller.taskId, leaseGeneration: caller.leaseGeneration }
        : {}),
      ...(caller.kind === 'agent' && !caller.managed
        ? {
            limitations: [
              'Rail cannot cancel this agent',
              'workspace isolation is not enforced',
              'usage is not accounted',
            ],
          }
        : {}),
    },
  };
}

export function agentListTasks(
  ctx: RailContext,
  caller: Caller,
  input: {
    projectId?: string | null;
    states?: TaskState[];
    dispatchable?: boolean;
    limit?: number;
    cursor?: string | null;
  },
) {
  const pid = authorize(caller, 'rail_list_tasks', input.projectId);
  const page = listTasks(ctx, {
    projectId: pid,
    ...(input.states ? { states: input.states } : {}),
    ...(input.dispatchable ? { dispatchable: true } : {}),
    limit: Math.min(input.limit ?? 50, 200),
    cursor: input.cursor ?? null,
  });
  return {
    nextCursor: page.nextCursor,
    tasks: page.items.map((t) => ({
      id: t.id,
      title: t.title,
      state: t.state,
      risk: t.risk,
      priority: t.priority,
      dependencies: t.dependencies,
      scopeHints: t.scopeHints,
      assignedAgentId: t.assignedAgentId,
      revision: t.revision,
    })),
  };
}

export function agentNextAction(
  ctx: RailContext,
  caller: Caller,
  input: { projectId?: string | null; taskId?: string; leaseGeneration?: number; claimToken?: string },
) {
  const pid = authorize(caller, 'rail_get_next_action', input.projectId);
  const agentId = callerAgentId(caller);
  if (!agentId) {
    throw new RailError('NOT_AUTHORIZED', 'rail_get_next_action needs a registered agent identity to suggest work');
  }
  const taskId = input.taskId ?? (caller.kind === 'session' ? caller.taskId : null);
  let lease: ReturnType<typeof leaseFor> | undefined;
  if (taskId) {
    try {
      lease = leaseFor(caller, { taskId, leaseGeneration: input.leaseGeneration, claimToken: input.claimToken });
    } catch {
      lease = undefined;
    }
  }
  return getNextAction(ctx, { agentId, projectId: pid, ...(lease ? { lease } : {}) });
}

export async function agentClaim(ctx: RailContext, caller: Caller, input: { taskId: string }): Promise<PreparedClaim> {
  assertToolAllowed(caller, 'rail_claim_task');
  const task = showTask(ctx, input.taskId).task;
  callerProject(caller, task.projectId);
  if (caller.kind === 'session') {
    throw new RailError(
      'POLICY_DENIED',
      'Managed sessions are launched with their lease; they cannot claim other tasks',
      {
        suggestion: 'Finish or hand off the current task, then ask rail_get_next_action.',
      },
    );
  }
  if (caller.kind !== 'agent') throw new RailError('NOT_AUTHORIZED', 'Claiming requires a registered agent');
  if (!caller.managed) {
    const assigned = task.assignedAgentId === caller.agentId;
    if (!assigned && task.risk === 'high') {
      throw new RailError(
        'APPROVAL_REQUIRED',
        `${task.id} is high risk; an operator must assign it to ${caller.agentName} first`,
        {
          suggestion: `rail task assign ${task.id} ${caller.agentName}`,
        },
      );
    }
    if (task.assignedAgentId && !assigned) {
      throw new RailError('POLICY_DENIED', `${task.id} is assigned to another agent`);
    }
  }
  return claimAndPrepare(ctx, {
    taskId: task.id,
    holder: { kind: 'agent', id: caller.agentId },
    actor: callerActor(caller),
  });
}

interface LeaseArgs {
  taskId: string;
  leaseGeneration?: number | undefined;
  claimToken?: string | undefined;
}

function taskProject(ctx: RailContext, caller: Caller, taskId: string): void {
  callerProject(caller, showTask(ctx, taskId).task.projectId);
}

export function agentHeartbeat(ctx: RailContext, caller: Caller, input: LeaseArgs) {
  assertToolAllowed(caller, 'rail_heartbeat');
  taskProject(ctx, caller, input.taskId);
  return heartbeat(ctx, leaseFor(caller, input));
}

export function agentProgress(
  ctx: RailContext,
  caller: Caller,
  input: LeaseArgs & { summary: string; percent?: number; commits?: string[] },
) {
  assertToolAllowed(caller, 'rail_report_progress');
  taskProject(ctx, caller, input.taskId);
  return reportProgress(ctx, {
    ...leaseFor(caller, input),
    summary: input.summary,
    ...(input.percent !== undefined ? { percent: input.percent } : {}),
    ...(input.commits ? { commits: input.commits } : {}),
  });
}

export interface HandoffArgs extends LeaseArgs {
  summary: string;
  worktreePath?: string | undefined;
  commits?: string[] | undefined;
  testEvidence?: TestEvidence[] | undefined;
  contextPackIds?: string[] | undefined;
  remainingIssues?: string[] | undefined;
}

function handoff(ctx: RailContext, caller: Caller, kind: HandoffKind, tool: AgentTool, input: HandoffArgs) {
  assertToolAllowed(caller, tool);
  taskProject(ctx, caller, input.taskId);
  return report(ctx, {
    ...leaseFor(caller, input),
    kind,
    handoff: {
      summary: input.summary,
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
      ...(input.commits ? { commits: input.commits } : {}),
      ...(input.testEvidence ? { testEvidence: input.testEvidence } : {}),
      ...(input.contextPackIds ? { contextPackIds: input.contextPackIds } : {}),
      ...(input.remainingIssues ? { remainingIssues: input.remainingIssues } : {}),
    },
  });
}

export function agentReportBlocker(ctx: RailContext, caller: Caller, input: HandoffArgs) {
  return handoff(ctx, caller, 'blocked', 'rail_report_blocker', input);
}

export function agentSubmitWork(
  ctx: RailContext,
  caller: Caller,
  input: HandoffArgs & { kind?: 'ready_for_pr' | 'needs_review' | 'completed' },
) {
  return handoff(ctx, caller, input.kind ?? 'ready_for_pr', 'rail_submit_work', input);
}
