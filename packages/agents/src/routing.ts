import type { Database } from 'bun:sqlite';
import {
  type AccountProfile,
  type Clock,
  CrewError,
  type ErrorCode,
  isExpired,
  type ProfileHealthStatus,
  type ProviderId,
} from '@crewyard/core';
import { type CrewContext, one } from '@crewyard/storage';
import { type AgentRuntimeConfig, defaultAgentRuntimeConfig } from './config.ts';
import { type AgentDefinition, requireAgent } from './definitions.ts';
import { dataRoutingDecision } from './egress.ts';
import { findPolicy } from './policies.ts';
import { findProfileRow, mapProfile, profileRef } from './profiles.ts';
import { providerManifest, SESSION_MODES, type SessionMode } from './registry.ts';
import { budgetStatuses } from './usage.ts';

export interface RouteInput {
  agentId: string;
  taskId?: string | null;
  projectId?: string | null;
  requiredCapability: SessionMode;
  model?: string | null;
}

export interface RouteDecision {
  agentId: string;
  profileId: string;
  profileRef: string;
  providerId: ProviderId;
  model: string | null;
  fallback: boolean;
  explanation: string[];
}

type Blocker = 'rate_limited' | 'capacity' | 'budget' | 'health';

const BLOCKER_CODES: Record<Blocker, ErrorCode> = {
  capacity: 'BUSY',
  rate_limited: 'RATE_LIMITED',
  health: 'UNAVAILABLE',
  budget: 'POLICY_DENIED',
};
const BLOCKER_PRECEDENCE: readonly Blocker[] = ['capacity', 'rate_limited', 'health', 'budget'];
const UNROUTABLE_HEALTH: ReadonlySet<ProfileHealthStatus> = new Set(['unauthenticated', 'unavailable']);

function chooseModel(
  agent: AgentDefinition,
  profile: AccountProfile,
  policyModels: readonly string[],
  requested: string | null,
): { model: string | null } | { reason: string } {
  const preferred =
    requested ?? agent.providerPreferences.find((p) => p.provider === profile.providerId)?.model ?? null;
  const allowedByProfile = (m: string) => profile.permittedModels.length === 0 || profile.permittedModels.includes(m);
  const allowedByPolicy = (m: string) => policyModels.length === 0 || policyModels.includes(m);
  if (preferred) {
    if (!allowedByProfile(preferred)) return { reason: `model ${preferred} is not permitted on this profile` };
    if (!allowedByPolicy(preferred)) return { reason: `model ${preferred} is not in the account policy allowlist` };
    return { model: preferred };
  }
  if (profile.permittedModels.length > 0) {
    const model = profile.permittedModels.find(allowedByPolicy);
    return model ? { model } : { reason: 'no permitted profile model is in the account policy allowlist' };
  }
  if (policyModels.length > 0) {
    return { reason: 'the policy restricts models but neither a model nor profile permitted models were given' };
  }
  return { model: null };
}

export function routeAgentInDb(
  db: Database,
  clock: Clock,
  input: RouteInput,
  config: AgentRuntimeConfig,
): RouteDecision {
  if (!SESSION_MODES.includes(input.requiredCapability)) {
    throw new CrewError('INVALID_INPUT', `Unknown capability ${input.requiredCapability}`);
  }
  const agent = requireAgent(db, input.agentId);
  if (!agent.managed) {
    throw new CrewError('POLICY_DENIED', `Agent ${agent.name} is unmanaged; Crewyard does not launch it`, {
      details: { limitations: agent.limitations },
    });
  }
  if (!agent.accountPolicyId) {
    throw new CrewError('POLICY_DENIED', `Agent ${agent.name} has no account policy`, {
      suggestion: 'Create an account policy (ordered profiles) and reference it from the agent.',
    });
  }
  const policy = findPolicy(db, agent.accountPolicyId);
  if (!policy) throw new CrewError('NOT_FOUND', `Account policy ${agent.accountPolicyId} no longer exists`);
  const allowFallback = policy.allowFallback || config.agents.allow_profile_fallback;
  const explanation: string[] = [
    `policy ${policy.name}: ${policy.profileIds.length} profile(s), fallback ${allowFallback ? 'allowed' : 'not allowed'}`,
  ];

  const permitted: { profile: AccountProfile; model: string | null }[] = [];
  for (const profileId of policy.profileIds) {
    const row = findProfileRow(db, profileId);
    if (!row) {
      explanation.push(`${profileId}: skipped, profile no longer exists`);
      continue;
    }
    const profile = mapProfile(row);
    const ref = profileRef(profile);
    if (!providerManifest(profile.providerId).supportsMode(profile, input.requiredCapability)) {
      explanation.push(`${ref}: skipped, provider does not support ${input.requiredCapability}`);
      continue;
    }
    const egress = dataRoutingDecision(config, profile.providerId, profile);
    if (egress.decision === 'deny') {
      explanation.push(`${ref}: skipped, data routing denied (${egress.reason})`);
      continue;
    }
    const choice = chooseModel(agent, profile, policy.models, input.model ?? null);
    if ('reason' in choice) {
      explanation.push(`${ref}: skipped, ${choice.reason}`);
      continue;
    }
    permitted.push({ profile, model: choice.model });
  }
  if (permitted.length === 0) {
    throw new CrewError('POLICY_DENIED', `No profile in policy ${policy.name} is permitted for this request`, {
      details: { explanation },
    });
  }

  const agentRunning = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ? AND state IN ('starting', 'running', 'stopping')`,
    agent.id,
  )!.n;
  if (agentRunning >= agent.maxParallel) {
    explanation.push(`agent ${agent.name} is at its parallel limit (${agentRunning}/${agent.maxParallel})`);
    throw new CrewError('BUSY', `Agent ${agent.name} already runs ${agentRunning} session(s)`, {
      details: { explanation },
    });
  }

  const task = input.taskId
    ? one<{ project_id: string }>(db, 'SELECT project_id FROM tasks WHERE id = ?', input.taskId)
    : null;
  const projectId = input.projectId ?? task?.project_id ?? null;
  const now = clock.now();
  const sharedBudgets = budgetStatuses(db, { agent: agent.id, task: input.taskId ?? null, project: projectId }, now);
  const blockers: Blocker[] = [];
  let retryAt: string | null = null;

  const candidates = allowFallback ? permitted : permitted.slice(0, 1);
  for (const [index, { profile, model }] of candidates.entries()) {
    const ref = profileRef(profile);
    const health = one<{ status: ProfileHealthStatus; rate_limited_until: string | null; detail: string | null }>(
      db,
      'SELECT status, rate_limited_until, detail FROM provider_health WHERE profile_id = ?',
      profile.id,
    );
    if (health?.status === 'rate_limited' && !isExpired(health.rate_limited_until, clock)) {
      explanation.push(`${ref}: skipped, rate limited until ${health.rate_limited_until ?? 'further notice'}`);
      if (health.rate_limited_until && (!retryAt || health.rate_limited_until < retryAt)) {
        retryAt = health.rate_limited_until;
      }
      blockers.push('rate_limited');
      continue;
    }
    if (health && UNROUTABLE_HEALTH.has(health.status)) {
      explanation.push(`${ref}: skipped, health is ${health.status}${health.detail ? ` (${health.detail})` : ''}`);
      blockers.push('health');
      continue;
    }
    const running = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sessions WHERE profile_id = ? AND state IN ('starting', 'running', 'stopping')`,
      profile.id,
    )!.n;
    if (running >= profile.maxConcurrency) {
      explanation.push(`${ref}: skipped, at capacity (${running}/${profile.maxConcurrency} sessions)`);
      blockers.push('capacity');
      continue;
    }
    const exceeded = [...sharedBudgets, ...budgetStatuses(db, { profile: profile.id }, now)].filter((b) => b.exceeded);
    if (exceeded.length > 0) {
      explanation.push(
        `${ref}: skipped, budget exceeded (${exceeded.map((b) => `${b.scope}/${b.period}`).join(', ')})`,
      );
      blockers.push('budget');
      continue;
    }
    const status = health?.status ?? 'unknown';
    explanation.push(
      `${ref}: selected${index > 0 ? ' as explicitly authorized fallback' : ''}; model ${model ?? 'provider default'}; health ${status}; capacity ${running + 1}/${profile.maxConcurrency}`,
    );
    return {
      agentId: agent.id,
      profileId: profile.id,
      profileRef: ref,
      providerId: profile.providerId,
      model,
      fallback: index > 0,
      explanation,
    };
  }
  if (!allowFallback && permitted.length > 1) {
    explanation.push(`${permitted.length - 1} other permitted profile(s) not tried: fallback is not authorized`);
  }
  const blocker = BLOCKER_PRECEDENCE.find((b) => blockers.includes(b)) ?? 'health';
  throw new CrewError(BLOCKER_CODES[blocker], `No eligible account for agent ${agent.name}: ${explanation.at(-1)}`, {
    details: { explanation, retryAt },
    suggestion:
      blocker === 'rate_limited'
        ? 'Work stays paused until the rate limit expires or an explicitly authorized fallback profile is added.'
        : 'Inspect `crew account list` and the agent account policy.',
  });
}

export function routeAgent(
  ctx: CrewContext,
  input: RouteInput,
  options: { config?: AgentRuntimeConfig } = {},
): RouteDecision {
  const config = options.config ?? defaultAgentRuntimeConfig();
  return ctx.store.read((db) => routeAgentInDb(db, ctx.clock, input, config));
}
