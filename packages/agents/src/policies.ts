import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, newId, nowIso, SYSTEM_ACTOR } from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition } from '@crewyard/storage';
import { requireProfileRow } from './profiles.ts';

const POLICY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export interface AccountPolicy {
  id: string;
  name: string;
  profileIds: string[];
  allowFallback: boolean;
  models: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AccountPolicyView extends AccountPolicy {
  profiles: string[];
  agents: string[];
}

interface PolicyRow {
  id: string;
  name: string;
  profile_ids: string;
  allow_fallback: number;
  models: string;
  created_at: string;
  updated_at: string;
}

export function mapPolicy(row: PolicyRow): AccountPolicy {
  return {
    id: row.id,
    name: row.name,
    profileIds: parseJson<string[]>(row.profile_ids, []),
    allowFallback: row.allow_fallback === 1,
    models: parseJson<string[]>(row.models, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findPolicy(db: Database, idOrName: string): AccountPolicy | null {
  const row = one<PolicyRow>(db, 'SELECT * FROM account_policies WHERE id = ? OR name = ?', idOrName, idOrName);
  return row ? mapPolicy(row) : null;
}

export function requirePolicy(db: Database, idOrName: string): AccountPolicy {
  const policy = findPolicy(db, idOrName);
  if (!policy) {
    throw new CrewError('NOT_FOUND', `Account policy not found: ${idOrName}`, {
      suggestion: 'Run `crew account policy list`.',
    });
  }
  return policy;
}

export function agentsUsingPolicy(db: Database, policyId: string): string[] {
  return all<{ name: string }>(db, 'SELECT name FROM agents WHERE account_policy_id = ? ORDER BY name', policyId).map(
    (r) => r.name,
  );
}

function viewPolicy(db: Database, policy: AccountPolicy): AccountPolicyView {
  const profiles = policy.profileIds.map((id) => {
    const row = one<{ provider_id: string; name: string }>(
      db,
      'SELECT provider_id, name FROM provider_profiles WHERE id = ?',
      id,
    );
    return row ? `${row.provider_id}/${row.name}` : id;
  });
  return { ...policy, profiles, agents: agentsUsingPolicy(db, policy.id) };
}

export function getAccountPolicy(ctx: CrewContext, idOrName: string): AccountPolicyView {
  return ctx.store.read((db) => viewPolicy(db, requirePolicy(db, idOrName)));
}

export function listAccountPolicies(ctx: CrewContext): AccountPolicyView[] {
  return ctx.store.read((db) =>
    all<PolicyRow>(db, 'SELECT * FROM account_policies ORDER BY name').map((row) => viewPolicy(db, mapPolicy(row))),
  );
}

function resolveProfiles(db: Database, refs: readonly string[]): string[] {
  if (refs.length === 0) throw new CrewError('INVALID_INPUT', 'An account policy needs at least one account');
  return [...new Set(refs.map((ref) => requireProfileRow(db, ref).id))];
}

function cleanModels(models: readonly string[] | undefined): string[] {
  return [...new Set((models ?? []).map((m) => m.trim()).filter(Boolean))];
}

export interface CreateAccountPolicyInput {
  name: string;
  profiles: string[];
  allowFallback?: boolean;
  models?: string[];
  actor?: Actor;
}

export function insertAccountPolicyInTx(db: Database, input: CreateAccountPolicyInput, at: string): AccountPolicy {
  if (!POLICY_NAME_PATTERN.test(input.name)) {
    throw new CrewError('INVALID_INPUT', `Invalid policy name ${input.name}`, {
      suggestion: 'Use letters, digits, dot, underscore or dash (max 63 characters).',
    });
  }
  if (findPolicy(db, input.name)) throw new CrewError('CONFLICT', `Account policy ${input.name} already exists`);
  const profileIds = resolveProfiles(db, input.profiles);
  const models = cleanModels(input.models);
  const id = newId('pol');
  db.query(
    'INSERT INTO account_policies (id, name, profile_ids, allow_fallback, models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, JSON.stringify(profileIds), input.allowFallback ? 1 : 0, JSON.stringify(models), at, at);
  recordTransition(
    db,
    {
      type: 'account_policy.created',
      actor: input.actor ?? SYSTEM_ACTOR,
      payload: { policyId: id, name: input.name, profileIds, allowFallback: Boolean(input.allowFallback), models },
    },
    { action: 'account_policy.create', input: { name: input.name, profileIds }, decision: 'accepted' },
    at,
  );
  return findPolicy(db, id)!;
}

export function createAccountPolicy(ctx: CrewContext, input: CreateAccountPolicyInput): AccountPolicyView {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => viewPolicy(db, insertAccountPolicyInTx(db, input, at)));
}

export interface UpdateAccountPolicyInput {
  profiles?: string[];
  allowFallback?: boolean;
  models?: string[];
  actor?: Actor;
}

export function updateAccountPolicy(
  ctx: CrewContext,
  idOrName: string,
  input: UpdateAccountPolicyInput,
): AccountPolicyView {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const policy = requirePolicy(db, idOrName);
    const profileIds = input.profiles ? resolveProfiles(db, input.profiles) : policy.profileIds;
    const allowFallback = input.allowFallback ?? policy.allowFallback;
    const models = input.models ? cleanModels(input.models) : policy.models;
    db.query(
      'UPDATE account_policies SET profile_ids = ?, allow_fallback = ?, models = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(profileIds), allowFallback ? 1 : 0, JSON.stringify(models), at, policy.id);
    recordTransition(
      db,
      {
        type: 'account_policy.updated',
        actor: input.actor ?? SYSTEM_ACTOR,
        payload: {
          policyId: policy.id,
          name: policy.name,
          before: { profileIds: policy.profileIds, allowFallback: policy.allowFallback, models: policy.models },
          after: { profileIds, allowFallback, models },
        },
      },
      { action: 'account_policy.update', input: { name: policy.name, profileIds }, decision: 'accepted' },
      at,
    );
    return viewPolicy(db, requirePolicy(db, policy.id));
  });
}

export function removeAccountPolicy(
  ctx: CrewContext,
  idOrName: string,
  input: { actor?: Actor; dryRun?: boolean } = {},
): AccountPolicy {
  const at = nowIso(ctx.clock);
  return (input.dryRun ? ctx.store.preview : ctx.store.immediate)((db) => {
    const policy = requirePolicy(db, idOrName);
    const agents = agentsUsingPolicy(db, policy.id);
    if (agents.length > 0) {
      throw new CrewError('CONFLICT', `Account policy ${policy.name} is used by ${agents.join(', ')}`, {
        details: { agents },
        suggestion: `Move ${agents.length === 1 ? 'that agent' : 'those agents'} first: \`crew agent update <agent> --policy <other>\` or \`--account <account>\`.`,
      });
    }
    db.query('DELETE FROM account_policies WHERE id = ?').run(policy.id);
    recordTransition(
      db,
      {
        type: 'account_policy.removed',
        actor: input.actor ?? SYSTEM_ACTOR,
        payload: { policyId: policy.id, name: policy.name },
      },
      { action: 'account_policy.remove', input: { name: policy.name }, decision: 'accepted' },
      at,
    );
    return policy;
  });
}
