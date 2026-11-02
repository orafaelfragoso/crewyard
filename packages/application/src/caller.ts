import { getAgent, verifySessionToken } from '@crewyard/agents';
import { type Actor, CrewError } from '@crewyard/core';
import type { CrewContext } from '@crewyard/storage';
import type { LeaseCredentials } from '@crewyard/tasks';

export const AGENT_TOOLS = [
  'crew_get_state',
  'crew_search_context',
  'crew_get_symbol',
  'crew_analyze_impact',
  'crew_list_tasks',
  'crew_get_next_action',
  'crew_claim_task',
  'crew_heartbeat',
  'crew_report_progress',
  'crew_report_blocker',
  'crew_submit_work',
  'crew_submit_pr',
  'crew_get_review',
  'crew_request_review',
  'crew_request_integration',
  'crew_get_queue_status',
] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];

export const READ_ONLY_TOOLS: ReadonlySet<AgentTool> = new Set([
  'crew_get_state',
  'crew_search_context',
  'crew_get_symbol',
  'crew_analyze_impact',
  'crew_list_tasks',
  'crew_get_next_action',
  'crew_get_review',
  'crew_get_queue_status',
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
  CREW_SESSION_TOKEN?: string | undefined;
  CREW_CLAIM_TOKEN?: string | undefined;
  CREW_LEASE_GENERATION?: string | undefined;
  CREW_AGENT?: string | undefined;
}

export function resolveCaller(
  ctx: CrewContext,
  env: CallerEnv | NodeJS.ProcessEnv,
  defaultProjectId: string | null,
): Caller {
  if (env.CREW_SESSION_TOKEN) {
    const binding = verifySessionToken(ctx, env.CREW_SESSION_TOKEN);
    if (!binding.agentId || !binding.projectId) {
      throw new CrewError('NOT_AUTHORIZED', 'Session token is not bound to an agent and project');
    }
    const agent = getAgent(ctx, binding.agentId);
    const generation = env.CREW_LEASE_GENERATION ? Number(env.CREW_LEASE_GENERATION) : null;
    return {
      kind: 'session',
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      projectId: binding.projectId,
      taskId: binding.taskId,
      leaseGeneration: generation === binding.leaseGeneration ? generation : binding.leaseGeneration,
      claimToken: env.CREW_CLAIM_TOKEN ?? null,
      allowedTools: agent.allowedMcpTools,
    };
  }
  if (env.CREW_AGENT) {
    const agent = getAgent(ctx, env.CREW_AGENT);
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
    throw new CrewError('NOT_AUTHORIZED', `${tool} requires a registered agent identity`, {
      suggestion:
        'Register this client with `crew agent create --unmanaged --name NAME --tools ...` and set CREW_AGENT=NAME in its MCP server environment.',
    });
  }
  if (caller.allowedTools && !caller.allowedTools.includes(tool)) {
    throw new CrewError('POLICY_DENIED', `${tool} is not in the operator-configured tool list for this agent`, {
      details: { allowed: caller.allowedTools },
    });
  }
}

export function assertProject(caller: Caller, projectId: string): void {
  const allowed = caller.kind === 'session' ? [caller.projectId] : caller.projectIds;
  if (!allowed.includes(projectId)) {
    throw new CrewError('NOT_AUTHORIZED', `This MCP session is not authorized for project ${projectId}`, {
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
    throw new CrewError('NOT_FOUND', 'No project is associated with this MCP session', {
      suggestion: 'Start `crew mcp` inside a registered repository or pass --project.',
    });
  }
  if (rest.length > 0) throw new CrewError('INVALID_INPUT', 'Several projects are authorized; pass projectId');
  return first;
}

export function leaseFor(
  caller: Caller,
  input: { taskId: string; leaseGeneration?: number | undefined; claimToken?: string | undefined },
): LeaseCredentials {
  if (caller.kind === 'session') {
    if (caller.taskId && input.taskId !== caller.taskId) {
      throw new CrewError('NOT_AUTHORIZED', `This managed session is bound to ${caller.taskId}, not ${input.taskId}`);
    }
    const token = input.claimToken ?? caller.claimToken;
    const generation = input.leaseGeneration ?? caller.leaseGeneration;
    if (token && generation !== null && generation !== undefined) return { taskId: input.taskId, generation, token };
  }
  if (input.claimToken && input.leaseGeneration !== undefined) {
    return { taskId: input.taskId, generation: input.leaseGeneration, token: input.claimToken };
  }
  throw new CrewError(
    'NOT_AUTHORIZED',
    'A current lease (leaseGeneration and claimToken from crew_claim_task) is required',
    {
      suggestion: 'Claim the task with crew_claim_task and pass the returned leaseGeneration and claimToken.',
    },
  );
}
