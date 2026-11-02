import type { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findSecretKeys } from '@agent-rail/config';
import {
  type AccountProfile,
  type Actor,
  type AuthMechanism,
  type Capabilities,
  canonicalPath,
  ensureDir,
  isExpired,
  isWithin,
  newId,
  nowIso,
  type ProfileHealth,
  type ProfileHealthStatus,
  type ProviderId,
  RailError,
  SYSTEM_ACTOR,
} from '@agent-rail/core';
import { all, one, parseJson, type RailContext, recordTransition } from '@agent-rail/storage';
import { createProviderRegistry, type LoginCommand, type ProviderRegistry, providerManifest } from './registry.ts';
import { type SecretStore, systemSecretStore } from './secrets.ts';

export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ACTIVE_SESSION_STATES = `('starting', 'running', 'stopping')`;

export interface ProfileHealthView {
  status: ProfileHealthStatus;
  detail: string | null;
  rateLimitedUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  checkedAt: string | null;
}

export interface ProfileView extends AccountProfile {
  ref: string;
  health: ProfileHealthView;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileRow {
  id: string;
  provider_id: ProviderId;
  name: string;
  display_name: string;
  auth_mechanism: AuthMechanism;
  auth_ref: string | null;
  config_root: string | null;
  permitted_models: string;
  max_concurrency: number;
  settings: string;
  created_at: string;
  updated_at: string;
}

interface HealthRow {
  status: ProfileHealthStatus;
  detail: string | null;
  rate_limited_until: string | null;
  consecutive_failures: number;
  last_error: string | null;
  last_checked_at: string;
}

export function mapProfile(row: ProfileRow): AccountProfile {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    displayName: row.display_name,
    authMechanism: row.auth_mechanism,
    authRef: row.auth_ref,
    configRoot: row.config_root,
    permittedModels: parseJson<string[]>(row.permitted_models, []),
    maxConcurrency: row.max_concurrency,
    settings: parseJson<Record<string, unknown>>(row.settings, {}),
  };
}

export function profileRef(profile: Pick<AccountProfile, 'providerId' | 'name'>): string {
  return `${profile.providerId}/${profile.name}`;
}

function healthView(row: HealthRow | null): ProfileHealthView {
  if (!row) {
    return {
      status: 'unknown',
      detail: 'not yet tested',
      rateLimitedUntil: null,
      consecutiveFailures: 0,
      lastError: null,
      checkedAt: null,
    };
  }
  return {
    status: row.status,
    detail: row.detail,
    rateLimitedUntil: row.rate_limited_until,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    checkedAt: row.last_checked_at,
  };
}

function viewOf(db: Database, row: ProfileRow): ProfileView {
  const profile = mapProfile(row);
  const health = one<HealthRow>(db, 'SELECT * FROM provider_health WHERE profile_id = ?', row.id);
  return {
    ...profile,
    ref: profileRef(profile),
    health: healthView(health),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findProfileRow(db: Database, ref: string): ProfileRow | null {
  const [provider, name] = ref.includes('/') ? ref.split('/', 2) : [null, null];
  return provider && name
    ? one<ProfileRow>(db, 'SELECT * FROM provider_profiles WHERE provider_id = ? AND name = ?', provider, name)
    : one<ProfileRow>(db, 'SELECT * FROM provider_profiles WHERE id = ?', ref);
}

export function requireProfileRow(db: Database, ref: string): ProfileRow {
  const row = findProfileRow(db, ref);
  if (!row) {
    throw new RailError('NOT_FOUND', `Account profile not found: ${ref}`, {
      suggestion: 'Run `rail account list`; profiles are referenced by id or provider/name.',
    });
  }
  return row;
}

export function getProfile(ctx: RailContext, ref: string): ProfileView {
  return ctx.store.read((db) => viewOf(db, requireProfileRow(db, ref)));
}

export function listProfiles(ctx: RailContext, filter: { providerId?: ProviderId } = {}): ProfileView[] {
  return ctx.store.read((db) =>
    (filter.providerId
      ? all<ProfileRow>(db, 'SELECT * FROM provider_profiles WHERE provider_id = ? ORDER BY name', filter.providerId)
      : all<ProfileRow>(db, 'SELECT * FROM provider_profiles ORDER BY provider_id, name')
    ).map((row) => viewOf(db, row)),
  );
}

export function profileLoginCommand(profile: AccountProfile): LoginCommand | null {
  return providerManifest(profile.providerId).loginCommand(profile);
}

export function profileSecretName(providerId: ProviderId, name: string): string {
  return `profile.${providerId}.${name}`;
}

export function defaultProfileConfigRoot(ctx: RailContext, providerId: ProviderId, name: string): string {
  return join(ctx.dirs.data, 'profiles', providerId, name);
}

export interface AddProfileInput {
  providerId: ProviderId;
  name: string;
  displayName?: string;
  authMechanism?: AuthMechanism;
  apiKey?: string;
  configRoot?: string | null;
  useProviderDefaultConfig?: boolean;
  permittedModels?: string[];
  maxConcurrency?: number;
  settings?: Record<string, unknown>;
  actor?: Actor;
}

const NON_SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(['apiKeyEnv']);

function validateSettings(settings: Record<string, unknown>): void {
  const scrubbed = Object.fromEntries(Object.entries(settings).filter(([k]) => !NON_SECRET_SETTING_KEYS.has(k)));
  const secrets = findSecretKeys(scrubbed);
  if (secrets.length > 0) {
    throw new RailError('INVALID_INPUT', `Profile settings must not contain secrets: ${secrets.join(', ')}`, {
      suggestion: 'Use an api-key profile so the credential is stored in the OS secret store.',
    });
  }
}

export async function addProfile(
  ctx: RailContext,
  input: AddProfileInput,
  options: { secrets?: SecretStore } = {},
): Promise<ProfileView> {
  const manifest = providerManifest(input.providerId);
  if (!PROFILE_NAME_PATTERN.test(input.name)) {
    throw new RailError('INVALID_INPUT', `Invalid profile name ${input.name}`, {
      suggestion: 'Use lowercase letters, digits, dot, underscore or dash.',
    });
  }
  const authMechanism = input.authMechanism ?? manifest.defaultAuth;
  if (!manifest.authMechanisms.includes(authMechanism)) {
    throw new RailError('INVALID_INPUT', `${manifest.displayName} does not support ${authMechanism} authentication`, {
      details: { supported: manifest.authMechanisms },
    });
  }
  if (authMechanism === 'api-key' && !input.apiKey) {
    throw new RailError('INVALID_INPUT', 'api-key profiles require an API key');
  }
  if (authMechanism !== 'api-key' && input.apiKey) {
    throw new RailError('INVALID_INPUT', `An API key is only accepted for api-key profiles, not ${authMechanism}`);
  }
  const maxConcurrency = input.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
    throw new RailError('INVALID_INPUT', 'maxConcurrency must be an integer between 1 and 64');
  }
  const settings = input.settings ?? {};
  validateSettings(settings);
  const permittedModels = [...new Set((input.permittedModels ?? []).map((m) => m.trim()).filter(Boolean))];

  let configRoot: string | null = null;
  if (manifest.configRootIsolation && !input.useProviderDefaultConfig) {
    configRoot = canonicalPath(input.configRoot ?? defaultProfileConfigRoot(ctx, input.providerId, input.name));
  } else if (input.configRoot) {
    throw new RailError('INVALID_INPUT', `${manifest.displayName} has no documented config-root isolation`);
  }

  const existing = ctx.store.read((db) => {
    if (findProfileRow(db, `${input.providerId}/${input.name}`)) {
      return `Profile ${input.providerId}/${input.name} already exists`;
    }
    if (configRoot && one(db, 'SELECT id FROM provider_profiles WHERE config_root = ?', configRoot)) {
      return `Another profile already uses config root ${configRoot}; profiles must not share an identity`;
    }
    if (
      manifest.configRootIsolation &&
      configRoot === null &&
      one(db, 'SELECT id FROM provider_profiles WHERE provider_id = ? AND config_root IS NULL', input.providerId)
    ) {
      return `Only one ${input.providerId} profile may use the provider's default configuration`;
    }
    return null;
  });
  if (existing) throw new RailError('CONFLICT', existing);

  if (configRoot) ensureDir(configRoot);
  const secrets = options.secrets ?? systemSecretStore;
  const authRef = authMechanism === 'api-key' ? profileSecretName(input.providerId, input.name) : null;
  if (authRef && input.apiKey) await secrets.set(authRef, input.apiKey);
  const at = nowIso(ctx.clock);
  const id = newId('prof');
  try {
    return ctx.store.immediate((db) => {
      db.query(
        `INSERT INTO provider_profiles (id, provider_id, name, display_name, auth_mechanism, auth_ref, config_root, permitted_models, max_concurrency, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.providerId,
        input.name,
        input.displayName ?? input.name,
        authMechanism,
        authRef,
        configRoot,
        JSON.stringify(permittedModels),
        maxConcurrency,
        JSON.stringify(settings),
        at,
        at,
      );
      db.query(
        `INSERT INTO provider_health (profile_id, status, detail, consecutive_failures, last_checked_at) VALUES (?, 'unknown', 'not yet tested', 0, ?)`,
      ).run(id, at);
      const ref = `${input.providerId}/${input.name}`;
      recordTransition(
        db,
        {
          type: 'profile.added',
          actor: input.actor ?? SYSTEM_ACTOR,
          payload: { profileId: id, ref, authMechanism, configRoot, permittedModels, maxConcurrency },
        },
        { action: 'profile.add', input: { ref, authMechanism }, decision: 'accepted', profileRef: ref },
        at,
      );
      return viewOf(db, requireProfileRow(db, id));
    });
  } catch (error) {
    if (authRef) await secrets.delete(authRef).catch(() => false);
    throw error;
  }
}

export interface RemoveProfileInput {
  actor?: Actor;
  purgeConfigRoot?: boolean;
}

export async function removeProfile(
  ctx: RailContext,
  ref: string,
  input: RemoveProfileInput = {},
  options: { secrets?: SecretStore } = {},
): Promise<{ profileId: string; ref: string; removedFromPolicies: string[]; configRootPurged: boolean }> {
  const at = nowIso(ctx.clock);
  const removed = ctx.store.immediate((db) => {
    const row = requireProfileRow(db, ref);
    const active = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sessions WHERE profile_id = ? AND state IN ${ACTIVE_SESSION_STATES}`,
      row.id,
    )!.n;
    if (active > 0) {
      throw new RailError('CONFLICT', `Profile ${ref} has ${active} active session(s)`, {
        suggestion: 'Stop the sessions first with `rail agent stop`.',
      });
    }
    const policies = all<{ id: string; name: string; profile_ids: string }>(
      db,
      'SELECT id, name, profile_ids FROM account_policies',
    );
    const touched: string[] = [];
    for (const policy of policies) {
      const ids = parseJson<string[]>(policy.profile_ids, []);
      if (!ids.includes(row.id)) continue;
      db.query('UPDATE account_policies SET profile_ids = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(ids.filter((p) => p !== row.id)),
        at,
        policy.id,
      );
      touched.push(policy.name);
    }
    db.query('DELETE FROM provider_profiles WHERE id = ?').run(row.id);
    const profile = mapProfile(row);
    recordTransition(
      db,
      {
        type: 'profile.removed',
        actor: input.actor ?? SYSTEM_ACTOR,
        payload: { profileId: row.id, ref: profileRef(profile), removedFromPolicies: touched },
      },
      { action: 'profile.remove', input: { ref }, decision: 'accepted', profileRef: profileRef(profile) },
      at,
    );
    return { profile, touched };
  });
  if (removed.profile.authRef) await (options.secrets ?? systemSecretStore).delete(removed.profile.authRef);
  const root = removed.profile.configRoot;
  const managedRoot = join(ctx.dirs.data, 'profiles');
  const purge = Boolean(input.purgeConfigRoot && root && existsSync(root) && isWithin(managedRoot, root));
  if (purge && root) rmSync(root, { recursive: true, force: true });
  return {
    profileId: removed.profile.id,
    ref: profileRef(removed.profile),
    removedFromPolicies: removed.touched,
    configRootPurged: purge,
  };
}

export interface HealthUpdate {
  status: ProfileHealthStatus;
  detail: string;
  rateLimitedUntil?: string | null;
  failure?: boolean;
  success?: boolean;
  lastError?: string | null;
}

export function writeProfileHealth(db: Database, profileId: string, update: HealthUpdate, at: string): void {
  const current = one<HealthRow>(db, 'SELECT * FROM provider_health WHERE profile_id = ?', profileId);
  const failures = update.success ? 0 : (current?.consecutive_failures ?? 0) + (update.failure ? 1 : 0);
  const rateLimitedUntil =
    update.rateLimitedUntil !== undefined
      ? update.rateLimitedUntil
      : update.success
        ? null
        : (current?.rate_limited_until ?? null);
  db.query(
    `INSERT INTO provider_health (profile_id, status, detail, rate_limited_until, consecutive_failures, last_error, last_checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, rate_limited_until = excluded.rate_limited_until,
       consecutive_failures = excluded.consecutive_failures, last_error = excluded.last_error, last_checked_at = excluded.last_checked_at`,
  ).run(
    profileId,
    update.status,
    update.detail.slice(0, 1_000),
    rateLimitedUntil,
    failures,
    update.lastError === undefined ? (current?.last_error ?? null) : (update.lastError?.slice(0, 1_000) ?? null),
    at,
  );
  if (current?.status !== update.status) {
    recordTransition(
      db,
      {
        type: 'profile.health_changed',
        actor: SYSTEM_ACTOR,
        payload: {
          profileId,
          from: current?.status ?? null,
          to: update.status,
          detail: update.detail,
          rateLimitedUntil,
        },
      },
      { action: 'profile.health', input: { profileId, status: update.status }, decision: update.status },
      at,
    );
  }
}

export function setProfileHealth(
  ctx: RailContext,
  ref: string,
  update: { status: ProfileHealthStatus; detail: string; rateLimitedUntil?: string | null },
): ProfileView {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const row = requireProfileRow(db, ref);
    writeProfileHealth(
      db,
      row.id,
      {
        ...update,
        rateLimitedUntil: update.status === 'rate_limited' ? (update.rateLimitedUntil ?? null) : null,
        ...(update.status === 'healthy' ? { success: true } : {}),
      },
      at,
    );
    return viewOf(db, row);
  });
}

export async function testProfile(
  ctx: RailContext,
  ref: string,
  options: { registry?: ProviderRegistry; secrets?: SecretStore } = {},
): Promise<{ profile: ProfileView; health: ProfileHealth; capabilities: Capabilities; login: LoginCommand | null }> {
  const profile = getProfile(ctx, ref);
  const registry = options.registry ?? createProviderRegistry(options.secrets ? { secrets: options.secrets } : {});
  const adapter = registry.get(profile.providerId);
  const [health, capabilities] = await Promise.all([adapter.validateProfile(profile), adapter.capabilities(profile)]);
  const at = nowIso(ctx.clock);
  const updated = ctx.store.immediate((db) => {
    const row = requireProfileRow(db, profile.id);
    const current = one<HealthRow>(db, 'SELECT * FROM provider_health WHERE profile_id = ?', row.id);
    const stillLimited =
      current?.status === 'rate_limited' &&
      current.rate_limited_until !== null &&
      !isExpired(current.rate_limited_until, ctx.clock) &&
      (health.status === 'healthy' || health.status === 'unknown');
    writeProfileHealth(
      db,
      row.id,
      stillLimited
        ? {
            status: 'rate_limited',
            detail: `${health.detail}; rate limited until ${current.rate_limited_until}`,
            rateLimitedUntil: current.rate_limited_until,
          }
        : {
            status: health.status,
            detail: health.detail,
            rateLimitedUntil: null,
            ...(health.status === 'healthy' ? { success: true } : {}),
          },
      at,
    );
    return viewOf(db, row);
  });
  return { profile: updated, health, capabilities, login: profileLoginCommand(updated) };
}
