import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, newId, nowIso, type ProviderId, SYSTEM_ACTOR } from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition } from '@crewyard/storage';
import { agentsUsingPolicy, findPolicy, insertAccountPolicyInTx, requirePolicy } from './policies.ts';
import { requireProfileRow } from './profiles.ts';
import { isProviderId } from './registry.ts';

export type ReviewAuthority = 'none' | 'advisory' | 'required';
export type NetworkPolicy = 'provider-and-github-only' | 'unrestricted' | 'offline';

const REVIEW_AUTHORITIES: readonly ReviewAuthority[] = ['none', 'advisory', 'required'];
const NETWORK_POLICIES: readonly NetworkPolicy[] = ['provider-and-github-only', 'unrestricted', 'offline'];
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const UNMANAGED_AGENT_LIMITATIONS: readonly string[] = [
  'No automatic cancellation: Crewyard did not start the process and cannot terminate it.',
  'No workspace enforcement: the agent works wherever it runs; Crewyard cannot confine it to a worktree.',
  'No usage accounting: token and cost usage are unknown unless the agent reports them.',
  'Authorization comes only from operator-configured tools and scopes, never from the agent id string.',
];

export interface ProviderPreference {
  provider: ProviderId;
  model?: string;
}

export interface AgentBudget {
  maxSessionMinutes?: number;
  maxOutputBytes?: number;
}

export interface FsPolicy {
  roots?: string[];
  allowedPaths?: string[];
}

export interface AgentTeamRef {
  teamId: string;
  name: string;
  role: string | null;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  systemInstructions: string | null;
  skills: string[];
  allowedMcpTools: string[] | null;
  providerPreferences: ProviderPreference[];
  accountPolicyId: string | null;
  budget: AgentBudget | null;
  fsPolicy: FsPolicy | null;
  networkPolicy: NetworkPolicy;
  reviewAuthority: ReviewAuthority;
  managed: boolean;
  maxParallel: number;
  projectIds: string[];
  teams: AgentTeamRef[];
  limitations: string[];
  createdAt: string;
  updatedAt: string;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  system_instructions: string | null;
  skills: string;
  allowed_mcp_tools: string | null;
  provider_preferences: string;
  account_policy_id: string | null;
  budget: string | null;
  fs_policy: string | null;
  network_policy: NetworkPolicy;
  review_authority: ReviewAuthority;
  managed: number;
  max_parallel: number;
  created_at: string;
  updated_at: string;
}

function mapAgent(db: Database, row: AgentRow): AgentDefinition {
  const managed = row.managed === 1;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    systemInstructions: row.system_instructions,
    skills: parseJson<string[]>(row.skills, []),
    allowedMcpTools: row.allowed_mcp_tools === null ? null : parseJson<string[]>(row.allowed_mcp_tools, []),
    providerPreferences: parseJson<ProviderPreference[]>(row.provider_preferences, []),
    accountPolicyId: row.account_policy_id,
    budget: parseJson<AgentBudget | null>(row.budget, null),
    fsPolicy: parseJson<FsPolicy | null>(row.fs_policy, null),
    networkPolicy: row.network_policy,
    reviewAuthority: row.review_authority,
    managed,
    maxParallel: row.max_parallel,
    projectIds: all<{ project_id: string }>(
      db,
      'SELECT project_id FROM agent_projects WHERE agent_id = ? ORDER BY project_id',
      row.id,
    ).map((r) => r.project_id),
    teams: all<{ team_id: string; name: string; role: string | null }>(
      db,
      'SELECT m.team_id, t.name, m.role FROM agent_team_memberships m JOIN teams t ON t.id = m.team_id WHERE m.agent_id = ? ORDER BY t.name',
      row.id,
    ).map((r) => ({ teamId: r.team_id, name: r.name, role: r.role })),
    limitations: managed ? [] : [...UNMANAGED_AGENT_LIMITATIONS],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findAgent(db: Database, idOrName: string): AgentDefinition | null {
  const row = one<AgentRow>(db, 'SELECT * FROM agents WHERE id = ? OR name = ?', idOrName, idOrName);
  return row ? mapAgent(db, row) : null;
}

export function requireAgent(db: Database, idOrName: string): AgentDefinition {
  const agent = findAgent(db, idOrName);
  if (!agent) {
    throw new CrewError('NOT_FOUND', `Agent not found: ${idOrName}`, { suggestion: 'Run `crew agent list`.' });
  }
  return agent;
}

export function getAgent(ctx: CrewContext, idOrName: string): AgentDefinition {
  return ctx.store.read((db) => requireAgent(db, idOrName));
}

export function listAgents(
  ctx: CrewContext,
  filter: { projectId?: string; managed?: boolean } = {},
): AgentDefinition[] {
  return ctx.store.read((db) => {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.projectId) {
      where.push('id IN (SELECT agent_id FROM agent_projects WHERE project_id = ?)');
      params.push(filter.projectId);
    }
    if (filter.managed !== undefined) {
      where.push('managed = ?');
      params.push(filter.managed ? 1 : 0);
    }
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`;
    return all<AgentRow>(db, sql, ...params).map((row) => mapAgent(db, row));
  });
}

function resolveProjectIds(db: Database, refs: readonly string[]): string[] {
  return [
    ...new Set(
      refs.map((ref) => {
        const row = one<{ id: string }>(db, 'SELECT id FROM projects WHERE id = ? OR name = ?', ref, ref);
        if (!row) throw new CrewError('NOT_FOUND', `Project not found: ${ref}`);
        return row.id;
      }),
    ),
  ];
}

function stringList(values: readonly string[] | undefined, label: string): string[] {
  const out = [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))];
  if (out.some((v) => v.length > 200)) throw new CrewError('INVALID_INPUT', `${label} entries must be short names`);
  return out;
}

function validateBudget(budget: AgentBudget | undefined): AgentBudget | null {
  if (!budget) return null;
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new CrewError('INVALID_INPUT', `budget.${key} must be a positive number`);
    }
  }
  return budget;
}

export interface CreateAgentInput {
  name: string;
  role?: string;
  systemInstructions?: string | null;
  skills?: string[];
  allowedMcpTools?: string[] | null;
  providerPreferences?: ProviderPreference[];
  accountPolicy?: string | null;
  account?: string;
  budget?: AgentBudget;
  fsPolicy?: FsPolicy | null;
  networkPolicy?: NetworkPolicy;
  reviewAuthority?: ReviewAuthority;
  maxParallel?: number;
  projects?: string[];
  actor?: Actor;
}

interface InsertAgent {
  name: string;
  role: string;
  systemInstructions: string | null;
  skills: string[];
  allowedMcpTools: string[] | null;
  providerPreferences: ProviderPreference[];
  accountPolicyId: string | null;
  account?: string;
  budget: AgentBudget | null;
  fsPolicy: FsPolicy | null;
  networkPolicy: NetworkPolicy;
  reviewAuthority: ReviewAuthority;
  managed: boolean;
  maxParallel: number;
  projectRefs: string[];
  actor: Actor;
}

function validateAgentFields(input: {
  reviewAuthority?: ReviewAuthority;
  networkPolicy?: NetworkPolicy;
  maxParallel?: number;
  providerPreferences?: ProviderPreference[];
}): void {
  if (input.reviewAuthority !== undefined && !REVIEW_AUTHORITIES.includes(input.reviewAuthority)) {
    throw new CrewError('INVALID_INPUT', `reviewAuthority must be one of ${REVIEW_AUTHORITIES.join(', ')}`);
  }
  if (input.networkPolicy !== undefined && !NETWORK_POLICIES.includes(input.networkPolicy)) {
    throw new CrewError('INVALID_INPUT', `networkPolicy must be one of ${NETWORK_POLICIES.join(', ')}`);
  }
  if (
    input.maxParallel !== undefined &&
    (!Number.isInteger(input.maxParallel) || input.maxParallel < 1 || input.maxParallel > 64)
  ) {
    throw new CrewError('INVALID_INPUT', 'maxParallel must be an integer between 1 and 64');
  }
  for (const pref of input.providerPreferences ?? []) {
    if (!isProviderId(pref.provider)) throw new CrewError('INVALID_INPUT', `Unknown provider ${pref.provider}`);
  }
}

export function agentAccountPolicyName(agentName: string, profileName: string): string {
  return `${agentName}-${profileName}`;
}

function singleAccountPolicyInTx(db: Database, agentName: string, account: string, actor: Actor, at: string): string {
  const profile = requireProfileRow(db, account);
  const name = agentAccountPolicyName(agentName, profile.name);
  const existing = findPolicy(db, name);
  if (existing) {
    const reusable =
      existing.profileIds.length === 1 &&
      existing.profileIds[0] === profile.id &&
      agentsUsingPolicy(db, existing.id).every((a) => a === agentName);
    if (!reusable) throw new CrewError('CONFLICT', `Account policy ${name} already exists with other settings`);
    return existing.id;
  }
  return insertAccountPolicyInTx(db, { name, profiles: [profile.id], allowFallback: false, actor }, at).id;
}

function insertAgent(ctx: CrewContext, input: InsertAgent): AgentDefinition {
  if (!AGENT_NAME_PATTERN.test(input.name)) {
    throw new CrewError('INVALID_INPUT', `Invalid agent name ${input.name}`, {
      suggestion: 'Use letters, digits, dot, underscore or dash (max 63 characters).',
    });
  }
  validateAgentFields(input);
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    if (findAgent(db, input.name)) throw new CrewError('CONFLICT', `Agent ${input.name} already exists`);
    const projectIds = resolveProjectIds(db, input.projectRefs);
    if (input.account) input.accountPolicyId = singleAccountPolicyInTx(db, input.name, input.account, input.actor, at);
    const id = newId('agt');
    db.query(
      `INSERT INTO agents (id, name, role, system_instructions, skills, allowed_mcp_tools, provider_preferences, account_policy_id, budget, fs_policy, network_policy, review_authority, managed, max_parallel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.role,
      input.systemInstructions,
      JSON.stringify(input.skills),
      input.allowedMcpTools === null ? null : JSON.stringify(input.allowedMcpTools),
      JSON.stringify(input.providerPreferences),
      input.accountPolicyId,
      input.budget ? JSON.stringify(input.budget) : null,
      input.fsPolicy ? JSON.stringify(input.fsPolicy) : null,
      input.networkPolicy,
      input.reviewAuthority,
      input.managed ? 1 : 0,
      input.maxParallel,
      at,
      at,
    );
    for (const projectId of projectIds) {
      db.query('INSERT INTO agent_projects (agent_id, project_id) VALUES (?, ?)').run(id, projectId);
    }
    recordTransition(
      db,
      {
        type: input.managed ? 'agent.created' : 'agent.registered_unmanaged',
        actor: input.actor,
        payload: {
          agentId: id,
          name: input.name,
          role: input.role,
          managed: input.managed,
          accountPolicyId: input.accountPolicyId,
          projectIds,
          allowedMcpTools: input.allowedMcpTools,
        },
      },
      {
        action: input.managed ? 'agent.create' : 'agent.register_unmanaged',
        input: { name: input.name, projectIds },
        decision: 'accepted',
        agentId: id,
      },
      at,
    );
    return findAgent(db, id)!;
  });
}

export function createAgent(ctx: CrewContext, input: CreateAgentInput): AgentDefinition {
  if (input.account && input.accountPolicy) {
    throw new CrewError('INVALID_INPUT', 'Pass either an account or an account policy, not both');
  }
  const accountPolicyId = input.accountPolicy
    ? ctx.store.read((db) => requirePolicy(db, input.accountPolicy!).id)
    : null;
  return insertAgent(ctx, {
    ...(input.account ? { account: input.account } : {}),
    name: input.name,
    role: input.role ?? 'engineer',
    systemInstructions: input.systemInstructions ?? null,
    skills: stringList(input.skills, 'skills'),
    allowedMcpTools: input.allowedMcpTools == null ? null : stringList(input.allowedMcpTools, 'allowedMcpTools'),
    providerPreferences: input.providerPreferences ?? [],
    accountPolicyId,
    budget: validateBudget(input.budget),
    fsPolicy: input.fsPolicy ?? null,
    networkPolicy: input.networkPolicy ?? 'provider-and-github-only',
    reviewAuthority: input.reviewAuthority ?? 'advisory',
    managed: true,
    maxParallel: input.maxParallel ?? 1,
    projectRefs: input.projects ?? [],
    actor: input.actor ?? SYSTEM_ACTOR,
  });
}

export interface RegisterUnmanagedAgentInput {
  name: string;
  role?: string;
  allowedTools: string[];
  scopes?: string[];
  projects?: string[];
  reviewAuthority?: ReviewAuthority;
  actor?: Actor;
}

export function registerUnmanagedAgent(ctx: CrewContext, input: RegisterUnmanagedAgentInput): AgentDefinition {
  const scopes = stringList(input.scopes, 'scopes');
  return insertAgent(ctx, {
    name: input.name,
    role: input.role ?? 'external',
    systemInstructions: null,
    skills: [],
    allowedMcpTools: stringList(input.allowedTools, 'allowedTools'),
    providerPreferences: [],
    accountPolicyId: null,
    budget: null,
    fsPolicy: scopes.length > 0 ? { allowedPaths: scopes } : null,
    networkPolicy: 'provider-and-github-only',
    reviewAuthority: input.reviewAuthority ?? 'none',
    managed: false,
    maxParallel: 1,
    projectRefs: input.projects ?? [],
    actor: input.actor ?? SYSTEM_ACTOR,
  });
}

export interface UpdateAgentInput {
  role?: string;
  systemInstructions?: string | null;
  skills?: string[];
  allowedMcpTools?: string[] | null;
  providerPreferences?: ProviderPreference[];
  accountPolicy?: string;
  account?: string;
  reviewAuthority?: ReviewAuthority;
  maxParallel?: number;
  projects?: string[] | null;
  actor?: Actor;
}

export interface AgentChange {
  agent: AgentDefinition;
  unusedPolicies: string[];
}

function unusedPolicyNames(db: Database, policyIds: readonly (string | null)[]): string[] {
  return policyIds
    .filter((id): id is string => id !== null)
    .filter((id) => agentsUsingPolicy(db, id).length === 0)
    .map((id) => findPolicy(db, id)?.name)
    .filter((name): name is string => name !== undefined);
}

export function updateAgent(ctx: CrewContext, idOrName: string, input: UpdateAgentInput): AgentChange {
  if (input.account && input.accountPolicy) {
    throw new CrewError('INVALID_INPUT', 'Pass either an account or an account policy, not both');
  }
  validateAgentFields(input);
  const actor = input.actor ?? SYSTEM_ACTOR;
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const agent = requireAgent(db, idOrName);
    if (!agent.managed && (input.account || input.accountPolicy || input.providerPreferences)) {
      throw new CrewError('INVALID_INPUT', `${agent.name} is unmanaged; Crewyard does not choose its account`);
    }
    const accountPolicyId = input.account
      ? singleAccountPolicyInTx(db, agent.name, input.account, actor, at)
      : input.accountPolicy
        ? requirePolicy(db, input.accountPolicy).id
        : agent.accountPolicyId;
    const next = {
      role: input.role?.trim() || agent.role,
      skills: input.skills ? stringList(input.skills, 'skills') : agent.skills,
      allowedMcpTools:
        input.allowedMcpTools === undefined
          ? agent.allowedMcpTools
          : input.allowedMcpTools === null
            ? null
            : stringList(input.allowedMcpTools, 'allowedMcpTools'),
      providerPreferences: input.providerPreferences ?? agent.providerPreferences,
      accountPolicyId,
      reviewAuthority: input.reviewAuthority ?? agent.reviewAuthority,
      maxParallel: input.maxParallel ?? agent.maxParallel,
    };
    const systemInstructions =
      input.systemInstructions === undefined ? agent.systemInstructions : input.systemInstructions;
    db.query(
      `UPDATE agents SET role = ?, system_instructions = ?, skills = ?, allowed_mcp_tools = ?, provider_preferences = ?,
         account_policy_id = ?, review_authority = ?, max_parallel = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.role,
      systemInstructions,
      JSON.stringify(next.skills),
      next.allowedMcpTools === null ? null : JSON.stringify(next.allowedMcpTools),
      JSON.stringify(next.providerPreferences),
      next.accountPolicyId,
      next.reviewAuthority,
      next.maxParallel,
      at,
      agent.id,
    );
    const projectIds =
      input.projects === undefined
        ? agent.projectIds
        : input.projects === null
          ? []
          : resolveProjectIds(db, input.projects);
    if (input.projects !== undefined) {
      db.query('DELETE FROM agent_projects WHERE agent_id = ?').run(agent.id);
      for (const projectId of projectIds) {
        db.query('INSERT INTO agent_projects (agent_id, project_id) VALUES (?, ?)').run(agent.id, projectId);
      }
    }
    recordTransition(
      db,
      {
        type: 'agent.updated',
        actor,
        payload: {
          agentId: agent.id,
          name: agent.name,
          before: {
            role: agent.role,
            skills: agent.skills,
            allowedMcpTools: agent.allowedMcpTools,
            providerPreferences: agent.providerPreferences,
            accountPolicyId: agent.accountPolicyId,
            reviewAuthority: agent.reviewAuthority,
            maxParallel: agent.maxParallel,
            projectIds: agent.projectIds,
          },
          after: { ...next, projectIds },
          instructionsChanged: input.systemInstructions !== undefined,
        },
      },
      { action: 'agent.update', input: { name: agent.name }, decision: 'accepted', agentId: agent.id },
      at,
    );
    return {
      agent: requireAgent(db, agent.id),
      unusedPolicies: accountPolicyId === agent.accountPolicyId ? [] : unusedPolicyNames(db, [agent.accountPolicyId]),
    };
  });
}

const ACTIVE_SESSION_STATES = ['starting', 'running', 'stopping'] as const;

export interface AgentRemoval extends AgentChange {
  unassignedTasks: string[];
}

export function removeAgent(
  ctx: CrewContext,
  idOrName: string,
  input: { actor?: Actor; dryRun?: boolean } = {},
): AgentRemoval {
  const at = nowIso(ctx.clock);
  return (input.dryRun ? ctx.store.preview : ctx.store.immediate)((db) => {
    const agent = requireAgent(db, idOrName);
    const sessions = all<{ id: string }>(
      db,
      `SELECT id FROM sessions WHERE agent_id = ? AND state IN (${ACTIVE_SESSION_STATES.map(() => '?').join(', ')})`,
      agent.id,
      ...ACTIVE_SESSION_STATES,
    ).map((r) => r.id);
    if (sessions.length > 0) {
      throw new CrewError('CONFLICT', `${agent.name} has running sessions: ${sessions.join(', ')}`, {
        details: { sessions },
        suggestion: `Stop them with \`crew agent stop <sessionId>\`, then remove ${agent.name} again.`,
      });
    }
    const claimed = all<{ task_id: string }>(
      db,
      `SELECT task_id FROM leases WHERE released_at IS NULL AND holder_kind = 'agent' AND holder_id = ? ORDER BY task_id`,
      agent.id,
    ).map((r) => r.task_id);
    if (claimed.length > 0) {
      throw new CrewError('CONFLICT', `${agent.name} has claimed tasks: ${claimed.join(', ')}`, {
        details: { tasks: claimed },
        suggestion: 'Return each one to the queue with `crew task retry <taskId> --reason "agent removed"`.',
      });
    }
    const unassignedTasks = all<{ id: string }>(
      db,
      'SELECT id FROM tasks WHERE assigned_agent_id = ? ORDER BY id',
      agent.id,
    ).map((r) => r.id);
    db.query('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?').run(agent.id);
    db.query(`DELETE FROM budgets WHERE scope_kind = 'agent' AND scope_id = ?`).run(agent.id);
    db.query('DELETE FROM agents WHERE id = ?').run(agent.id);
    recordTransition(
      db,
      {
        type: 'agent.removed',
        actor: input.actor ?? SYSTEM_ACTOR,
        payload: { agentId: agent.id, name: agent.name, unassignedTasks },
      },
      { action: 'agent.remove', input: { name: agent.name }, decision: 'accepted', agentId: agent.id },
      at,
    );
    return { agent, unassignedTasks, unusedPolicies: unusedPolicyNames(db, [agent.accountPolicyId]) };
  });
}

export function agentLimitations(agent: Pick<AgentDefinition, 'managed'>): string[] {
  return agent.managed ? [] : [...UNMANAGED_AGENT_LIMITATIONS];
}

export interface Team {
  id: string;
  name: string;
  description: string;
  members: { agentId: string; name: string; role: string | null }[];
  createdAt: string;
}

function mapTeam(db: Database, row: { id: string; name: string; description: string; created_at: string }): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    members: all<{ agent_id: string; name: string; role: string | null }>(
      db,
      'SELECT m.agent_id, a.name, m.role FROM agent_team_memberships m JOIN agents a ON a.id = m.agent_id WHERE m.team_id = ? ORDER BY a.name',
      row.id,
    ).map((m) => ({ agentId: m.agent_id, name: m.name, role: m.role })),
    createdAt: row.created_at,
  };
}

function findTeam(db: Database, idOrName: string): Team | null {
  const row = one<{ id: string; name: string; description: string; created_at: string }>(
    db,
    'SELECT * FROM teams WHERE id = ? OR name = ?',
    idOrName,
    idOrName,
  );
  return row ? mapTeam(db, row) : null;
}

export function createTeam(ctx: CrewContext, input: { name: string; description?: string; actor?: Actor }): Team {
  if (!AGENT_NAME_PATTERN.test(input.name)) throw new CrewError('INVALID_INPUT', `Invalid team name ${input.name}`);
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    if (findTeam(db, input.name)) throw new CrewError('CONFLICT', `Team ${input.name} already exists`);
    const id = newId('team');
    db.query('INSERT INTO teams (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      input.name,
      input.description ?? '',
      at,
    );
    recordTransition(
      db,
      { type: 'team.created', actor: input.actor ?? SYSTEM_ACTOR, payload: { teamId: id, name: input.name } },
      { action: 'team.create', input: { name: input.name }, decision: 'accepted' },
      at,
    );
    return findTeam(db, id)!;
  });
}

export function listTeams(ctx: CrewContext): Team[] {
  return ctx.store.read((db) =>
    all<{ id: string; name: string; description: string; created_at: string }>(
      db,
      'SELECT * FROM teams ORDER BY name',
    ).map((row) => mapTeam(db, row)),
  );
}

export function assignAgentToTeam(
  ctx: CrewContext,
  input: { agent: string; team: string; role?: string | null; actor?: Actor },
): Team {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const agent = requireAgent(db, input.agent);
    const team = findTeam(db, input.team);
    if (!team) throw new CrewError('NOT_FOUND', `Team not found: ${input.team}`);
    db.query(
      `INSERT INTO agent_team_memberships (agent_id, team_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, team_id) DO UPDATE SET role = excluded.role`,
    ).run(agent.id, team.id, input.role ?? null, at);
    recordTransition(
      db,
      {
        type: 'team.member_assigned',
        actor: input.actor ?? SYSTEM_ACTOR,
        payload: { teamId: team.id, agentId: agent.id, role: input.role ?? null },
      },
      { action: 'team.assign', input: { teamId: team.id, agentId: agent.id }, decision: 'accepted', agentId: agent.id },
      at,
    );
    return findTeam(db, team.id)!;
  });
}
