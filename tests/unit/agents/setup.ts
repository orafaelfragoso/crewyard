import { join } from 'node:path';
import {
  type AgentRuntimeConfig,
  addProfile,
  createAccountPolicy,
  createAgent,
  createMemorySecretStore,
  defaultAgentRuntimeConfig,
  type ProfileView,
} from '@agent-rail/agents';
import { addSeconds, nowIso, type ProviderId } from '@agent-rail/core';
import type { RailContext } from '@agent-rail/storage';

export const FAKE_AGENT = join(import.meta.dir, '../../../fixtures/providers/fake-agent.ts');

export function testConfig(overrides: Partial<AgentRuntimeConfig['agents']> = {}): AgentRuntimeConfig {
  const config = defaultAgentRuntimeConfig();
  return { ...config, agents: { ...config.agents, cancel_grace_seconds: 1, ...overrides } };
}

export function fakeAgentSettings(args: string[] = []): Record<string, unknown> {
  return { command: process.execPath, args: [FAKE_AGENT, ...args] };
}

export interface SeedProfile {
  name: string;
  providerId?: ProviderId;
  maxConcurrency?: number;
  permittedModels?: string[];
  settings?: Record<string, unknown>;
}

export async function seedAgent(
  ctx: RailContext,
  input: {
    agentName?: string;
    profiles?: SeedProfile[];
    allowFallback?: boolean;
    models?: string[];
    maxParallel?: number;
    systemInstructions?: string;
  } = {},
): Promise<{ agentId: string; profiles: ProfileView[]; secrets: ReturnType<typeof createMemorySecretStore> }> {
  const secrets = createMemorySecretStore();
  const profiles: ProfileView[] = [];
  for (const spec of input.profiles ?? [{ name: 'fake' }]) {
    profiles.push(
      await addProfile(
        ctx,
        {
          providerId: spec.providerId ?? 'generic',
          name: spec.name,
          maxConcurrency: spec.maxConcurrency ?? 4,
          permittedModels: spec.permittedModels ?? [],
          settings: spec.settings ?? fakeAgentSettings(),
        },
        { secrets },
      ),
    );
  }
  const policy = createAccountPolicy(ctx, {
    name: `${input.agentName ?? 'builder'}-policy`,
    profiles: profiles.map((p) => p.id),
    allowFallback: input.allowFallback ?? false,
    models: input.models ?? [],
  });
  const agent = createAgent(ctx, {
    name: input.agentName ?? 'builder',
    accountPolicy: policy.name,
    maxParallel: input.maxParallel ?? 8,
    ...(input.systemInstructions ? { systemInstructions: input.systemInstructions } : {}),
  });
  return { agentId: agent.id, profiles, secrets };
}

export function seedLeasedTask(
  ctx: RailContext,
  input: { generation?: number; leaseSeconds?: number } = {},
): { projectId: string; taskId: string; generation: number } {
  const at = nowIso(ctx.clock);
  const projectId = `prj_${crypto.randomUUID().replaceAll('-', '')}`;
  const taskId = `tsk_${crypto.randomUUID().replaceAll('-', '')}`;
  const generation = input.generation ?? 1;
  ctx.store.immediate((db) => {
    db.query('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      projectId,
      projectId,
      at,
      at,
    );
    db.query(
      `INSERT INTO tasks (id, project_id, title, state, lease_generation, created_at, updated_at, state_changed_at) VALUES (?, ?, 'task', 'in_progress', ?, ?, ?, ?)`,
    ).run(taskId, projectId, generation, at, at, at);
    db.query(
      `INSERT INTO leases (id, task_id, generation, holder_kind, holder_id, token_hash, acquired_at, expires_at, heartbeat_at)
       VALUES (?, ?, ?, 'agent', 'builder', 'x', ?, ?, ?)`,
    ).run(`lease_${taskId}`, taskId, generation, at, addSeconds(at, input.leaseSeconds ?? 3600), at);
  });
  return { projectId, taskId, generation };
}
