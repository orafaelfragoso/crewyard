import type { SerializedCrewError } from './errors.ts';

export type Risk = 'low' | 'medium' | 'high';
export const RISKS: readonly Risk[] = ['low', 'medium', 'high'];

export type AutonomyMode = 'observe' | 'assisted' | 'guarded' | 'autopilot';
export const AUTONOMY_MODES: readonly AutonomyMode[] = ['observe', 'assisted', 'guarded', 'autopilot'];

export type WorkItemKind = 'epic' | 'task' | 'subtask';
export type TaskOrigin = 'manual' | 'issue' | 'ai';
export type HandoffKind = 'blocked' | 'needs_review' | 'ready_for_pr' | 'completed';

export type ActorKind = 'operator' | 'agent' | 'session' | 'service' | 'system' | 'github';
export interface Actor {
  kind: ActorKind;
  id: string;
}

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'crewyard' };

export type ConfidenceTier = 'exact' | 'structural' | 'heuristic';

export type UsageSource = 'measured' | 'estimated' | 'unknown';
export type CostSource = 'reported' | 'configured_rate' | 'unknown';

export interface UsageReport {
  model?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  usageSource: UsageSource;
  costSource: CostSource;
}

export const UNKNOWN_USAGE: UsageReport = {
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  costUsd: null,
  usageSource: 'unknown',
  costSource: 'unknown',
};

export type ProviderId = 'codex' | 'claude' | 'opencode' | 'generic' | 'ollama';

export type AuthMechanism = 'cli-login' | 'api-key' | 'local' | 'none';

export interface AccountProfile {
  id: string;
  providerId: ProviderId;
  name: string;
  displayName: string;
  authMechanism: AuthMechanism;
  authRef: string | null;
  configRoot: string | null;
  permittedModels: string[];
  maxConcurrency: number;
  settings: Record<string, unknown>;
}

export interface Capabilities {
  providerId: ProviderId;
  version: string | null;
  available: boolean;
  structuredEvents: boolean;
  usageReporting: UsageSource;
  resume: boolean;
  cancel: boolean;
  modelSelection: boolean;
  profileIsolation: 'config-root' | 'env' | 'none';
  codingAgent: boolean;
  planningReview: boolean;
  notes: string[];
}

export type ProfileHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'rate_limited'
  | 'unavailable'
  | 'unauthenticated'
  | 'unknown';

export interface ProfileHealth {
  status: ProfileHealthStatus;
  detail: string;
  checkedAt: string;
  rateLimitedUntil?: string | null;
}

export interface AgentLaunch {
  sessionId: string;
  profile: AccountProfile;
  model: string | null;
  prompt: string;
  systemInstructions: string | null;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  logPath: string;
  mode: 'execute' | 'plan' | 'review';
  outputSchema?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'started'; at: string; pid: number | null; providerSessionId?: string | null }
  | { type: 'message'; at: string; role: 'assistant' | 'user' | 'system'; text: string }
  | { type: 'tool'; at: string; name: string; status: 'started' | 'completed' | 'failed'; detail?: string }
  | { type: 'usage'; at: string; usage: UsageReport }
  | { type: 'log'; at: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'error'; at: string; message: string; classification: FailureClass }
  | { type: 'completed'; at: string; outcome: SessionOutcome; exitCode: number | null; result?: string };

export type SessionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface AgentSessionHandle {
  sessionId: string;
  pid: number | null;
  events: AsyncIterable<AgentEvent>;
  done: Promise<{ outcome: SessionOutcome; exitCode: number | null; usage: UsageReport; result: string | null }>;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities(profile: AccountProfile): Promise<Capabilities>;
  validateProfile(profile: AccountProfile): Promise<ProfileHealth>;
  launch(input: AgentLaunch): Promise<AgentSessionHandle>;
  attach?(sessionId: string): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
}

export type FailureClass =
  | 'transient_provider'
  | 'transient_network'
  | 'transient_ci'
  | 'rate_limited'
  | 'compilation'
  | 'test_failure'
  | 'merge_conflict'
  | 'authentication'
  | 'policy_violation'
  | 'missing_permissions'
  | 'ambiguous_remote'
  | 'unknown';

export interface ToolSuccess<T> {
  ok: true;
  operationId: string;
  data: T;
  revision: number;
}

export interface ToolFailure {
  ok: false;
  operationId: string;
  error: SerializedCrewError;
  revision?: number;
}

export type ToolEnvelope<T> = ToolSuccess<T> | ToolFailure;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Provenance {
  repositoryId: string;
  commitSha: string;
  retrievedAt: string;
  indexStatus: 'fresh' | 'stale' | 'building' | 'missing';
}
