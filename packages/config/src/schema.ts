import * as z from 'zod';

export const CONFIG_VERSION = 1;

export const DEFAULT_SENSITIVE_PATHS: Record<string, string[]> = {
  'security-sensitive': [
    '**/auth/**',
    '**/authentication/**',
    '**/security/**',
    '**/permissions/**',
    '**/rbac/**',
    '**/*secret*',
    '**/*credential*',
    '**/payments/**',
    '**/billing/**',
    '**/.env*',
  ],
  'database-migration': ['**/migrations/**', '**/migrate/**', '**/*.sql', '**/schema.prisma', '**/alembic/**'],
  'deployment-config': [
    '.github/workflows/**',
    '**/Dockerfile',
    '**/docker-compose*.yml',
    '**/k8s/**',
    '**/helm/**',
    '**/terraform/**',
    '**/*.tf',
    '**/deploy/**',
    '**/infra/**',
  ],
  'dependency-change': [
    '**/package.json',
    '**/bun.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/Cargo.toml',
    '**/Cargo.lock',
    '**/pyproject.toml',
    '**/requirements*.txt',
    '**/poetry.lock',
    '**/uv.lock',
  ],
};

const commandSpec = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  paths: z.array(z.string()).default([]),
  timeout_seconds: z.int().positive().max(86_400).default(900),
});

const rateSpec = z.strictObject({
  provider: z.enum(['codex', 'claude', 'opencode', 'generic', 'ollama']),
  model: z.string().min(1),
  input_per_mtok_usd: z.number().nonnegative(),
  output_per_mtok_usd: z.number().nonnegative(),
});

export const CREW_POLICY_CLASS = 'crew-policy';
export const CREW_POLICY_PATHS: readonly string[] = ['.crewyard/**'];

export const approvalClasses = [
  'crew-policy',
  'security-sensitive',
  'database-migration',
  'deployment-config',
  'dependency-change',
  'high-risk',
] as const;

export const crewConfigSchema = z.strictObject({
  version: z.literal(CONFIG_VERSION),
  project: z.strictObject({
    name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/, 'project.name may only contain letters, numbers, dot, underscore, dash'),
    repository: z.string().default('.'),
    base_branch: z.string().min(1).default('main'),
    autonomy: z.enum(['observe', 'assisted', 'guarded', 'autopilot']).default('guarded'),
  }),
  agents: z
    .strictObject({
      max_parallel: z.int().min(1).max(64).default(6),
      default_task_lease_seconds: z.int().min(30).max(86_400).default(900),
      heartbeat_interval_seconds: z.int().min(5).max(3_600).default(120),
      max_retries_per_failure: z.int().min(0).max(20).default(2),
      cancel_grace_seconds: z.int().min(0).max(600).default(10),
      session_timeout_minutes: z.int().min(1).max(1_440).default(90),
      max_output_bytes: z
        .int()
        .min(1_024)
        .default(50 * 1024 * 1024),
      allow_profile_fallback: z.boolean().default(false),
    })
    .prefault({}),
  scheduler: z
    .strictObject({
      max_open_prs: z.int().min(1).max(500).default(8),
      max_queue_age_minutes: z.int().min(1).default(120),
      protect_high_risk_scopes: z.boolean().default(true),
      fairness: z.enum(['weighted', 'fifo', 'strict-priority']).default('weighted'),
      wip: z
        .strictObject({
          global: z.int().min(1).optional(),
          project: z.int().min(1).optional(),
          repository: z.int().min(1).optional(),
          agent: z.int().min(1).default(1),
          account: z.int().min(1).optional(),
        })
        .prefault({}),
      integration_capacity_per_branch: z.int().min(1).max(32).default(1),
      reserve_recovery_capacity: z.int().min(0).max(16).default(1),
      tick_interval_seconds: z.int().min(1).max(3_600).default(15),
    })
    .prefault({}),
  index: z
    .strictObject({
      enabled: z.boolean().default(true),
      incremental: z.boolean().default(true),
      languages: z
        .array(z.enum(['typescript', 'javascript', 'python', 'rust']))
        .default(['typescript', 'javascript', 'python', 'rust']),
      semantic_embeddings: z.enum(['off', 'optional', 'required']).default('optional'),
      embedding: z
        .strictObject({
          provider: z.enum(['none', 'ollama']).default('none'),
          model: z.string().optional(),
          endpoint: z.url().optional(),
          consent_external: z.boolean().default(false),
        })
        .prefault({}),
      max_context_tokens: z.int().min(256).max(200_000).default(8_000),
      max_file_bytes: z
        .int()
        .min(1_024)
        .max(50 * 1024 * 1024)
        .default(1024 * 1024),
      exclude: z.array(z.string()).default(['**/node_modules/**', '**/target/**', '**/dist/**']),
    })
    .prefault({}),
  review: z
    .strictObject({
      enabled: z.boolean().default(true),
      incremental: z.boolean().default(true),
      cache_enabled: z.boolean().default(true),
      require_review_for_high_risk: z.boolean().default(true),
      cache_ttl_hours: z
        .int()
        .min(1)
        .max(24 * 90)
        .default(24 * 7),
      reviewer_agent: z.string().optional(),
      policy_version: z.string().default('1'),
    })
    .prefault({}),
  integration: z
    .strictObject({
      mode: z.enum(['auto', 'github-managed', 'crew-managed']).default('auto'),
      auto_merge_eligible: z.boolean().default(true),
      require_github_checks: z.boolean().default(true),
      rebasing: z.enum(['only_when_required', 'never']).default('only_when_required'),
      speculative_validation: z.boolean().default(true),
      merge_method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
      branch_name_format: z.string().default('crew/{task_id}-{slug}'),
      poll_interval_seconds: z.int().min(5).max(3_600).default(60),
    })
    .prefault({}),
  security: z
    .strictObject({
      credential_store: z.enum(['system', 'encrypted-file']).default('system'),
      network: z.enum(['provider-and-github-only', 'unrestricted', 'offline']).default('provider-and-github-only'),
      require_approval_for: z
        .array(z.enum(approvalClasses))
        .default(['security-sensitive', 'database-migration', 'deployment-config']),
      sensitive_paths: z.record(z.string(), z.array(z.string())).default(DEFAULT_SENSITIVE_PATHS),
      data_routing: z.record(z.string(), z.enum(['allow', 'deny'])).default({}),
    })
    .prefault({}),
  workspace: z
    .strictObject({
      setup_commands: z.array(z.string()).default([]),
      install_commands: z.array(z.string()).default([]),
      env_allowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([]),
      secret_refs: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)).default([]),
      timeout_seconds: z.int().min(1).max(7_200).default(600),
      cleanup: z.enum(['after_merge', 'manual', 'retention']).default('after_merge'),
      retention_days: z.int().min(0).default(14),
    })
    .prefault({}),
  validation: z
    .strictObject({
      fast: z.array(commandSpec).default([]),
      broad: z.array(commandSpec).default([]),
    })
    .prefault({}),
  observability: z
    .strictObject({
      local_only: z.literal(true).default(true),
      keep_events_days: z.int().min(1).max(3_650).default(90),
      rates: z.array(rateSpec).default([]),
    })
    .prefault({}),
});

export type CrewConfig = z.output<typeof crewConfigSchema>;
export type CrewConfigInput = z.input<typeof crewConfigSchema>;
