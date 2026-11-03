import { type Actor, CrewError, type HandoffKind, type TaskState } from '@crewyard/core';
import {
  explainPullRequest,
  getQueueStatus,
  listPullRequests,
  requestIntegration,
  requestPullRequestReview,
  showPullRequest,
} from '@crewyard/integration';
import { getProject, loadProjectConfig, primaryRepository } from '@crewyard/projects';
import { listFindings, listReviews } from '@crewyard/reviews';
import type { CrewContext } from '@crewyard/storage';
import {
  getNextAction,
  heartbeat,
  listTasks,
  report,
  reportProgress,
  showTask,
  type TestEvidence,
} from '@crewyard/tasks';
import { overviewProjection } from '@crewyard/telemetry';
import { collectCommits, commitWorkspaceChanges, listWorkspaces } from '@crewyard/workspaces';
import {
  type AgentTool,
  assertToolAllowed,
  type Caller,
  callerActor,
  callerAgentId,
  callerProject,
  leaseFor,
} from './caller.ts';
import { contextFingerprints, integrationEnv, reviewersFor } from './integration.ts';
import { publishTask } from './publish.ts';
import { serviceStatus } from './service-control.ts';
import { claimAndPrepare, type PreparedClaim } from './work.ts';

export function authorize(caller: Caller, tool: AgentTool, projectId?: string | null): string {
  assertToolAllowed(caller, tool);
  return callerProject(caller, projectId);
}

export function agentState(ctx: CrewContext, caller: Caller, projectId?: string | null) {
  const pid = authorize(caller, 'crew_get_state', projectId);
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
        'Agents never merge. Integration goes through crew_request_integration and GitHub branch protections.',
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
              'Crewyard cannot cancel this agent',
              'workspace isolation is not enforced',
              'usage is not accounted',
            ],
          }
        : {}),
    },
  };
}

export function agentListTasks(
  ctx: CrewContext,
  caller: Caller,
  input: {
    projectId?: string | null;
    states?: TaskState[];
    dispatchable?: boolean;
    limit?: number;
    cursor?: string | null;
  },
) {
  const pid = authorize(caller, 'crew_list_tasks', input.projectId);
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
  ctx: CrewContext,
  caller: Caller,
  input: { projectId?: string | null; taskId?: string; leaseGeneration?: number; claimToken?: string },
) {
  const pid = authorize(caller, 'crew_get_next_action', input.projectId);
  const agentId = callerAgentId(caller);
  if (!agentId) {
    throw new CrewError('NOT_AUTHORIZED', 'crew_get_next_action needs a registered agent identity to suggest work');
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

export async function agentClaim(ctx: CrewContext, caller: Caller, input: { taskId: string }): Promise<PreparedClaim> {
  assertToolAllowed(caller, 'crew_claim_task');
  const task = showTask(ctx, input.taskId).task;
  callerProject(caller, task.projectId);
  if (caller.kind === 'session') {
    throw new CrewError(
      'POLICY_DENIED',
      'Managed sessions are launched with their lease; they cannot claim other tasks',
      {
        suggestion: 'Finish or hand off the current task, then ask crew_get_next_action.',
      },
    );
  }
  if (caller.kind !== 'agent') throw new CrewError('NOT_AUTHORIZED', 'Claiming requires a registered agent');
  if (!caller.managed) {
    const assigned = task.assignedAgentId === caller.agentId;
    if (!assigned && task.risk === 'high') {
      throw new CrewError(
        'APPROVAL_REQUIRED',
        `${task.id} is high risk; an operator must assign it to ${caller.agentName} first`,
        {
          suggestion: `crew task assign ${task.id} ${caller.agentName}`,
        },
      );
    }
    if (task.assignedAgentId && !assigned) {
      throw new CrewError('POLICY_DENIED', `${task.id} is assigned to another agent`);
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

function taskProject(ctx: CrewContext, caller: Caller, taskId: string): void {
  callerProject(caller, showTask(ctx, taskId).task.projectId);
}

export function agentHeartbeat(ctx: CrewContext, caller: Caller, input: LeaseArgs) {
  assertToolAllowed(caller, 'crew_heartbeat');
  taskProject(ctx, caller, input.taskId);
  return heartbeat(ctx, leaseFor(caller, input));
}

export function agentProgress(
  ctx: CrewContext,
  caller: Caller,
  input: LeaseArgs & { summary: string; percent?: number; commits?: string[] },
) {
  assertToolAllowed(caller, 'crew_report_progress');
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

function handoff(ctx: CrewContext, caller: Caller, kind: HandoffKind, tool: AgentTool, input: HandoffArgs) {
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

export function agentReportBlocker(ctx: CrewContext, caller: Caller, input: HandoffArgs) {
  return handoff(ctx, caller, 'blocked', 'crew_report_blocker', input);
}

export async function commitTaskWorkspace(
  ctx: CrewContext,
  taskId: string,
  input: { summary: string; actor: Actor },
): Promise<string[] | null> {
  const [workspace] = listWorkspaces(ctx, { taskId, states: ['in_use', 'ready'] });
  if (!workspace) return null;
  const subject = input.summary.split('\n')[0]!.trim().slice(0, 72) || `${taskId} changes`;
  await commitWorkspaceChanges(ctx, workspace.id, { message: `${taskId}: ${subject}`, actor: input.actor });
  return (await collectCommits(ctx, workspace.id)).commits.map((c) => c.sha);
}

export async function agentSubmitWork(
  ctx: CrewContext,
  caller: Caller,
  input: HandoffArgs & { kind?: 'ready_for_pr' | 'needs_review' | 'completed' },
) {
  assertToolAllowed(caller, 'crew_submit_work');
  taskProject(ctx, caller, input.taskId);
  const commits = await commitTaskWorkspace(ctx, input.taskId, { summary: input.summary, actor: callerActor(caller) });
  const merged = commits ? [...new Set([...(input.commits ?? []), ...commits])] : input.commits;
  return handoff(ctx, caller, input.kind ?? 'ready_for_pr', 'crew_submit_work', {
    ...input,
    ...(merged ? { commits: merged } : {}),
  });
}

function ownedTask(ctx: CrewContext, caller: Caller, taskId: string) {
  const detail = showTask(ctx, taskId);
  callerProject(caller, detail.task.projectId);
  const agentId = callerAgentId(caller);
  const holder = detail.lease?.holder ?? detail.lastLease?.holder ?? null;
  const owns =
    holder !== null &&
    ((holder.kind === 'agent' && holder.id === agentId) || (caller.kind === 'session' && caller.taskId === taskId));
  if (!owns) {
    throw new CrewError('NOT_AUTHORIZED', `Only the agent that worked on ${taskId} may publish or queue it`, {
      details: { holder },
    });
  }
  return detail;
}

function prForTask(ctx: CrewContext, taskId: string) {
  const pr = listPullRequests(ctx, { taskId, limit: 1 })[0];
  if (!pr)
    throw new CrewError('NOT_FOUND', `No pull request is recorded for ${taskId}`, {
      suggestion: 'Call crew_submit_pr first.',
    });
  return pr;
}

export async function agentSubmitPr(ctx: CrewContext, caller: Caller, input: { taskId: string }) {
  assertToolAllowed(caller, 'crew_submit_pr');
  ownedTask(ctx, caller, input.taskId);
  return publishTask(ctx, {
    taskId: input.taskId,
    actor: callerActor(caller),
    leaderId: `mcp:${process.pid}`,
    enqueue: false,
  });
}

export function agentGetReview(
  ctx: CrewContext,
  caller: Caller,
  input: { taskId?: string; prNumber?: number; projectId?: string | null },
) {
  const projectId = authorize(caller, 'crew_get_review', input.projectId);
  const repo = primaryRepository(ctx, projectId);
  const pr = input.taskId
    ? prForTask(ctx, input.taskId)
    : input.prNumber
      ? showPullRequest(ctx, { repositoryId: repo.id, number: input.prNumber })
      : null;
  if (!pr) throw new CrewError('INVALID_INPUT', 'Pass taskId or prNumber');
  return {
    pullRequest: {
      number: pr.number,
      headSha: pr.headSha,
      state: pr.state,
      checksState: pr.checksState,
      reviewDecision: pr.reviewDecision,
    },
    reviews: listReviews(ctx, { prId: pr.id }),
    openFindings: listFindings(ctx, { prId: pr.id, status: 'open' }),
    note: 'AI review is supplementary evidence; required GitHub checks and reviews remain authoritative.',
  };
}

export async function agentRequestReview(ctx: CrewContext, caller: Caller, input: { taskId: string }) {
  assertToolAllowed(caller, 'crew_request_review');
  const detail = ownedTask(ctx, caller, input.taskId);
  const pr = prForTask(ctx, input.taskId);
  return requestPullRequestReview(
    ctx,
    { prId: pr.id },
    {
      reviewers: reviewersFor(ctx, detail.task.projectId),
      context: contextFingerprints(ctx),
      env: integrationEnv(ctx),
    },
  );
}

export async function agentRequestIntegration(ctx: CrewContext, caller: Caller, input: { taskId: string }) {
  assertToolAllowed(caller, 'crew_request_integration');
  const detail = ownedTask(ctx, caller, input.taskId);
  const pr = prForTask(ctx, input.taskId);
  return requestIntegration(
    ctx,
    { prId: pr.id, priority: detail.task.priority, requestedBy: callerActor(caller) },
    integrationEnv(ctx),
  );
}

export function agentQueueStatus(
  ctx: CrewContext,
  caller: Caller,
  input: { taskId?: string; prNumber?: number; projectId?: string | null },
) {
  const projectId = authorize(caller, 'crew_get_queue_status', input.projectId);
  const repo = primaryRepository(ctx, projectId);
  const env = integrationEnv(ctx);
  const pr = input.taskId
    ? prForTask(ctx, input.taskId)
    : input.prNumber
      ? showPullRequest(ctx, { repositoryId: repo.id, number: input.prNumber })
      : null;
  if (!pr) return getQueueStatus(ctx, { repositoryId: repo.id, baseBranch: repo.defaultBase }, env);
  return { queue: getQueueStatus(ctx, { prId: pr.id }, env), explanation: explainPullRequest(ctx, pr.id, env) };
}
