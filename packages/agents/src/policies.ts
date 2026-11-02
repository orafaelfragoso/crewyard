import type { Database } from 'bun:sqlite';
import { type Actor, CrewError, newId, nowIso, SYSTEM_ACTOR } from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition } from '@crewyard/storage';
import { requireProfileRow } from './profiles.ts';

export interface AccountPolicy {
  id: string;
  name: string;
  profileIds: string[];
  allowFallback: boolean;
  models: string[];
  createdAt: string;
  updatedAt: string;
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

export function getAccountPolicy(ctx: CrewContext, idOrName: string): AccountPolicy {
  const policy = ctx.store.read((db) => findPolicy(db, idOrName));
  if (!policy) throw new CrewError('NOT_FOUND', `Account policy not found: ${idOrName}`);
  return policy;
}

export function listAccountPolicies(ctx: CrewContext): AccountPolicy[] {
  return all<PolicyRow>(ctx.store.db, 'SELECT * FROM account_policies ORDER BY name').map(mapPolicy);
}

export interface CreateAccountPolicyInput {
  name: string;
  profiles: string[];
  allowFallback?: boolean;
  models?: string[];
  actor?: Actor;
}

export function createAccountPolicy(ctx: CrewContext, input: CreateAccountPolicyInput): AccountPolicy {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(input.name)) {
    throw new CrewError('INVALID_INPUT', `Invalid policy name ${input.name}`);
  }
  if (input.profiles.length === 0) {
    throw new CrewError('INVALID_INPUT', 'An account policy needs at least one profile');
  }
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    if (findPolicy(db, input.name)) throw new CrewError('CONFLICT', `Account policy ${input.name} already exists`);
    const profileIds = [...new Set(input.profiles.map((ref) => requireProfileRow(db, ref).id))];
    const models = [...new Set((input.models ?? []).map((m) => m.trim()).filter(Boolean))];
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
  });
}
