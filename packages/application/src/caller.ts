import { getAgent, verifySessionToken } from '@agent-rail/agents';
import { type Actor, RailError } from '@agent-rail/core';
import type { RailContext } from '@agent-rail/storage';
import type { LeaseCredentials } from '@agent-rail/tasks';

export const AGENT_TOOLS = [
  'rail_get_state',
  'rail_search_context',
  'rail_get_symbol',
  'rail_analyze_impact',
  'rail_list_tasks',
  'rail_get_next_action',
  'rail_claim_task',
  'rail_heartbeat',
  'rail_report_progress',
  'rail_report_blocker',
  'rail_submit_work',
  'rail_submit_pr',
  'rail_get_review',
  'rail_request_review',
  'rail_request_integration',
  'rail_get_queue_status',
] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];

export const READ_ONLY_TOOLS: ReadonlySet<AgentTool> = new Set([
  'rail_get_state',
  'rail_search_context',
  'rail_get_symbol',
  'rail_analyze_impact',
  'rail_list_tasks',
  'rail_get_next_action',
  'rail_get_review',
  'rail_get_queue_status',
]);

export type Caller =
  | {
      kind: 'session';
      sessionId: string;
      agentId: string;
      projectId: string;
      taskId: string | null;
      leaseGeneration: number | null;
      claimToken: string | null;
      allowedTools: readonly string[] | null;
    }
  | {
      kind: 'agent';
      agentId: string;
      agentName: string;
      managed: boolean;
      projectIds: readonly string[];
      allowedTools: readonly string[] | null;
    }
  | { kind: 'anonymous'; projectIds: readonly string[] };

export function callerActor(caller: Caller): Actor {
  if (caller.kind === 'session') return { kind: 'session', id: caller.sessionId };
  if (caller.kind === 'agent') return { kind: 'agent', id: caller.agentId };
  return { kind: 'agent', id: 'anonymous' };
}

export function callerAgentId(caller: Caller): string | null {
  return caller.kind === 'anonymous' ? null : caller.agentId;
}

export interface CallerEnv {
  RAIL_SESSION_TOKEN?: string | undefined;
  RAIL_CLAIM_TOKEN?: string | undefined;
  RAIL_LEASE_GENERATION?: string | undefined;
  RAIL_AGENT?: string | undefined;
}

export function resolveCaller(
  ctx: RailContext,
  env: CallerEnv | NodeJS.ProcessEnv,
  defaultProjectId: string | null,
): Caller {
  if (env.RAIL_SESSION_TOKEN) {
    const binding = verifySessionToken(ctx, env.RAIL_SESSION_TOKEN);
    if (!binding.agentId || !binding.projectId) {
      throw new RailError('NOT_AUTHORIZED', 'Session token is not bound to an agent and project');
    }
    const agent = getAgent(ctx, binding.agentId);
    const generation = env.RAIL_LEASE_GENERATION ? Number(env.RAIL_LEASE_GENERATION) : null;
    return {
      kind: 'session',
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      projectId: binding.projectId,
      taskId: binding.taskId,
      leaseGeneration: generation === binding.leaseGeneration ? generation : binding.leaseGeneration,
      claimToken: env.RAIL_CLAIM_TOKEN ?? null,
      allowedTools: agent.allowedMcpTools,
    };
  }
  if (env.RAIL_AGENT) {
    const agent = getAgent(ctx, env.RAIL_AGENT);
    return {
      kind: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      managed: agent.managed,
      projectIds: agent.projectIds.length > 0 ? agent.projectIds : defaultProjectId ? [defaultProjectId] : [],
      allowedTools: agent.allowedMcpTools,
    };
  }
  return { kind: 'anonymous', projectIds: defaultProjectId ? [defaultProjectId] : [] };
}

export function assertToolAllowed(caller: Caller, tool: AgentTool): void {
  if (caller.kind === 'anonymous') {
    if (READ_ONLY_TOOLS.has(tool)) return;
    throw new RailError('NOT_AUTHORIZED', `${tool} requires a registered agent identity`, {
      suggestion:
        'Register this client with `rail agent create --unmanaged --name NAME --tools ...` and set RAIL_AGENT=NAME in its MCP server environment.',
    });
  }
  if (caller.allowedTools && !caller.allowedTools.includes(tool)) {
    throw new RailError('POLICY_DENIED', `${tool} is not in the operator-configured tool list for this agent`, {
      details: { allowed: caller.allowedTools },
    });
  }
}

export function assertProject(caller: Caller, projectId: string): void {
  const allowed = caller.kind === 'session' ? [caller.projectId] : caller.projectIds;
  if (!allowed.includes(projectId)) {
    throw new RailError('NOT_AUTHORIZED', `This MCP session is not authorized for project ${projectId}`, {
      details: { authorizedProjects: allowed },
    });
  }
}

export function callerProject(caller: Caller, requested?: string | null): string {
  if (requested) {
    assertProject(caller, requested);
    return requested;
  }
  if (caller.kind === 'session') return caller.projectId;
  const [first, ...rest] = caller.projectIds;
  if (!first) {
    throw new RailError('NOT_FOUND', 'No project is associated with this MCP session', {
      suggestion: 'Start `rail mcp` inside a registered repository or pass --project.',
    });
  }
  if (rest.length > 0) throw new RailError('INVALID_INPUT', 'Several projects are authorized; pass projectId');
  return first;
}

export function leaseFor(
  caller: Caller,
  input: { taskId: string; leaseGeneration?: number | undefined; claimToken?: string | undefined },
): LeaseCredentials {
  if (caller.kind === 'session') {
    if (caller.taskId && input.taskId !== caller.taskId) {
      throw new RailError('NOT_AUTHORIZED', `This managed session is bound to ${caller.taskId}, not ${input.taskId}`);
    }
    const token = input.claimToken ?? caller.claimToken;
    const generation = input.leaseGeneration ?? caller.leaseGeneration;
    if (token && generation !== null && generation !== undefined) return { taskId: input.taskId, generation, token };
  }
  if (input.claimToken && input.leaseGeneration !== undefined) {
    return { taskId: input.taskId, generation: input.leaseGeneration, token: input.claimToken };
  }
  throw new RailError(
    'NOT_AUTHORIZED',
    'A current lease (leaseGeneration and claimToken from rail_claim_task) is required',
    {
      suggestion: 'Claim the task with rail_claim_task and pass the returned leaseGeneration and claimToken.',
    },
  );
}
