import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CrewDirs, CrewError, isSecretKeyName, redactObject, redactSecrets } from '@crewyard/core';
import { parseDocument } from 'yaml';
import type * as z from 'zod';
import { type CrewConfig, crewConfigSchema } from './schema.ts';

export const REPO_CONFIG_RELATIVE = join('.crewyard', 'config.yaml');

export type ConfigSource = 'default' | 'user' | 'repository' | 'env' | 'flag';

export interface ConfigIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface LoadedConfig {
  config: CrewConfig;
  sources: Record<string, ConfigSource>;
  files: { repository: string | null; user: string | null };
  warnings: ConfigIssue[];
}

type Plain = Record<string, unknown>;

const ENV_MAP: Record<string, { path: string; type: 'string' | 'int' | 'bool' | 'list' }> = {
  CREW_AUTONOMY: { path: 'project.autonomy', type: 'string' },
  CREW_BASE_BRANCH: { path: 'project.base_branch', type: 'string' },
  CREW_MAX_PARALLEL: { path: 'agents.max_parallel', type: 'int' },
  CREW_LEASE_SECONDS: { path: 'agents.default_task_lease_seconds', type: 'int' },
  CREW_HEARTBEAT_SECONDS: { path: 'agents.heartbeat_interval_seconds', type: 'int' },
  CREW_MAX_OPEN_PRS: { path: 'scheduler.max_open_prs', type: 'int' },
  CREW_INTEGRATION_MODE: { path: 'integration.mode', type: 'string' },
  CREW_AUTO_MERGE: { path: 'integration.auto_merge_eligible', type: 'bool' },
  CREW_NETWORK: { path: 'security.network', type: 'string' },
  CREW_MAX_CONTEXT_TOKENS: { path: 'index.max_context_tokens', type: 'int' },
  CREW_INDEX_LANGUAGES: { path: 'index.languages', type: 'list' },
};

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlain(value) && isPlain(out[key]) ? deepMerge(out[key] as Plain, value) : value;
  }
  return out;
}

function flattenPaths(value: unknown, prefix = ''): string[] {
  if (!isPlain(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([k, v]) => flattenPaths(v, prefix ? `${prefix}.${k}` : k));
}

export function setPath(target: Plain, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Plain;
  }
  cursor[parts.at(-1)!] = value;
}

export function getPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => (isPlain(acc) ? acc[part] : undefined), source);
}

const SCHEMA_KEYS = new Set(['credential_store', 'secret_refs']);

export function findSecretKeys(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return redactSecrets(value).redactions > 0 ? [prefix || '(value)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretKeys(v, `${prefix}[${i}]`));
  if (!isPlain(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' && isSecretKeyName(k) && !SCHEMA_KEYS.has(k)) return [path];
    return findSecretKeys(v, path);
  });
}

export function readYamlFile(path: string): Plain {
  const text = readFileSync(path, 'utf8');
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new CrewError('CONFIG_INVALID', `Invalid YAML in ${path}: ${doc.errors[0]!.message}`, {
      details: { file: path },
      retryable: false,
    });
  }
  const value = doc.toJS() as unknown;
  if (value == null) return {};
  if (!isPlain(value)) throw new CrewError('CONFIG_INVALID', `${path} must contain a YAML mapping`);
  return value;
}

function parseEnv(env: NodeJS.ProcessEnv): Plain {
  const out: Plain = {};
  for (const [name, spec] of Object.entries(ENV_MAP)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    let value: unknown = raw;
    if (spec.type === 'int') value = Number.parseInt(raw, 10);
    if (spec.type === 'bool') value = /^(1|true|yes|on)$/i.test(raw);
    if (spec.type === 'list')
      value = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    setPath(out, spec.path, value);
  }
  return out;
}

export function zodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
    severity: 'error' as const,
  }));
}

export function contradictions(config: CrewConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const add = (path: string, message: string, severity: ConfigIssue['severity'] = 'error') =>
    issues.push({ path, message, severity });
  if (config.review.require_review_for_high_risk && !config.review.enabled) {
    add('review.require_review_for_high_risk', 'requires review.enabled: true');
  }
  if (config.index.incremental && !config.index.enabled) add('index.incremental', 'requires index.enabled: true');
  if (config.agents.heartbeat_interval_seconds * 2 > config.agents.default_task_lease_seconds) {
    add('agents.heartbeat_interval_seconds', 'must be at most half of agents.default_task_lease_seconds');
  }
  if (config.integration.auto_merge_eligible && ['observe', 'assisted'].includes(config.project.autonomy)) {
    add(
      'integration.auto_merge_eligible',
      `cannot be true when project.autonomy is ${config.project.autonomy}; merges require explicit operator authorization`,
    );
  }
  if (config.index.semantic_embeddings === 'required' && config.index.embedding.provider === 'none') {
    add('index.semantic_embeddings', "is 'required' but index.embedding.provider is 'none'");
  }
  if (config.index.embedding.provider !== 'none' && !config.index.embedding.model) {
    add('index.embedding.model', 'is required when an embedding provider is configured');
  }
  if (config.index.embedding.endpoint) {
    const host = new URL(config.index.embedding.endpoint).hostname;
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
    if (!local && !config.index.embedding.consent_external) {
      add('index.embedding.endpoint', 'is not local; set consent_external: true to send repository data to it');
    }
  }
  if (config.security.network === 'offline' && config.integration.auto_merge_eligible) {
    add('security.network', 'offline mode pauses all remote merges; auto_merge_eligible has no effect', 'warning');
  }
  if (!config.integration.require_github_checks) {
    add(
      'integration.require_github_checks',
      'disabling makes Crewyard ignore required checks it can observe; GitHub rules still apply',
      'warning',
    );
  }
  if (!config.integration.branch_name_format.includes('{task_id}')) {
    add('integration.branch_name_format', 'must contain {task_id} to keep branches unique per task');
  }
  for (const cls of config.security.require_approval_for) {
    if (cls !== 'high-risk' && !config.security.sensitive_paths[cls]) {
      add(`security.require_approval_for`, `class '${cls}' has no security.sensitive_paths entry`);
    }
  }
  return issues;
}

export interface LoadConfigOptions {
  repoRoot?: string | null;
  dirs: CrewDirs;
  env?: NodeJS.ProcessEnv;
  flags?: Record<string, unknown>;
  projectNameFallback?: string;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const repoFile = options.repoRoot ? join(options.repoRoot, REPO_CONFIG_RELATIVE) : null;
  const userFile = join(options.dirs.config, 'config.yaml');
  const layers: { source: ConfigSource; value: Plain; file?: string }[] = [];
  const userExists = existsSync(userFile);
  const repoExists = repoFile !== null && existsSync(repoFile);
  if (userExists) layers.push({ source: 'user', value: readYamlFile(userFile), file: userFile });
  if (repoExists) layers.push({ source: 'repository', value: readYamlFile(repoFile!), file: repoFile! });
  layers.push({ source: 'env', value: parseEnv(options.env ?? process.env) });
  const flags: Plain = {};
  for (const [path, value] of Object.entries(options.flags ?? {})) if (value !== undefined) setPath(flags, path, value);
  layers.push({ source: 'flag', value: flags });

  for (const layer of layers) {
    if (layer.source === 'env' || layer.source === 'flag') continue;
    const secrets = findSecretKeys(layer.value);
    if (secrets.length > 0) {
      throw new CrewError(
        'CONFIG_INVALID',
        `Secrets are not accepted in configuration files (${layer.file}): ${secrets.join(', ')}`,
        {
          suggestion: 'Store credentials with `crew account add` (system secret store) and reference them by name.',
          retryable: false,
        },
      );
    }
  }

  let merged: Plain = { version: 1, project: { name: options.projectNameFallback ?? 'project' } };
  const sources: Record<string, ConfigSource> = {};
  for (const layer of layers) {
    merged = deepMerge(merged, layer.value);
    for (const path of flattenPaths(layer.value)) sources[path] = layer.source;
  }

  const parsed = crewConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new CrewError('CONFIG_INVALID', 'Configuration is invalid', {
      details: { issues: zodIssues(parsed.error) },
      suggestion: 'Run `crew config validate` for the full list of problems.',
      retryable: false,
    });
  }
  const issues = contradictions(parsed.data);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new CrewError(
      'CONFIG_INVALID',
      `Configuration contradictions: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      {
        details: { issues: errors },
        retryable: false,
      },
    );
  }
  for (const path of flattenPaths(parsed.data)) sources[path] ??= 'default';
  return {
    config: parsed.data,
    sources,
    files: { repository: repoExists ? repoFile : null, user: userExists ? userFile : null },
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

export function validateConfigText(text: string): ConfigIssue[] {
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) return doc.errors.map((e) => ({ path: '(yaml)', message: e.message, severity: 'error' }));
  const value = (doc.toJS() ?? {}) as unknown;
  const secrets = findSecretKeys(value).map((path) => ({
    path,
    message: 'secrets are not accepted in YAML; use the system secret store',
    severity: 'error' as const,
  }));
  const parsed = crewConfigSchema.safeParse(value);
  if (!parsed.success) return [...secrets, ...zodIssues(parsed.error)];
  return [...secrets, ...contradictions(parsed.data)];
}

export function effectiveConfigView(loaded: LoadedConfig): {
  config: CrewConfig;
  sources: Record<string, ConfigSource>;
} {
  return { config: redactObject(loaded.config), sources: loaded.sources };
}
