import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CrewError, ensureDir } from '@crewyard/core';
import { parseDocument } from 'yaml';
import { findSecretKeys, validateConfigText } from './load.ts';

function setPathValue(segments: string[], value: unknown): Record<string, unknown> {
  return segments.reduceRight<Record<string, unknown>>(
    (acc, key, index) => ({ [key]: index === segments.length - 1 ? value : acc }),
    {},
  );
}

export interface TemplateInput {
  projectName: string;
  baseBranch: string;
  autonomy?: 'observe' | 'assisted' | 'guarded' | 'autopilot';
}

export function renderConfigTemplate(input: TemplateInput): string {
  return `# Crewyard repository configuration. Safe to commit: never put secrets here.
version: 1
project:
  name: ${input.projectName}
  repository: .
  base_branch: ${input.baseBranch}
  autonomy: ${input.autonomy ?? 'guarded'}

agents:
  max_parallel: 6
  default_task_lease_seconds: 900
  heartbeat_interval_seconds: 120
  max_retries_per_failure: 2

scheduler:
  max_open_prs: 8
  max_queue_age_minutes: 120
  protect_high_risk_scopes: true
  fairness: weighted

index:
  enabled: true
  incremental: true
  languages: [typescript, javascript, python, rust]
  semantic_embeddings: optional
  max_context_tokens: 8000
  exclude:
    - '**/node_modules/**'
    - '**/target/**'
    - '**/dist/**'

review:
  enabled: true
  incremental: true
  cache_enabled: true
  require_review_for_high_risk: true

integration:
  mode: auto # github-managed if available, otherwise crew-managed
  auto_merge_eligible: ${input.autonomy === 'observe' || input.autonomy === 'assisted' ? 'false' : 'true'}
  require_github_checks: true
  rebasing: only_when_required
  speculative_validation: true

security:
  credential_store: system
  network: provider-and-github-only
  require_approval_for:
    - security-sensitive
    - database-migration
    - deployment-config

observability:
  local_only: true
  keep_events_days: 90
`;
}

function coerce(raw: string): unknown {
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export interface SetConfigResult {
  file: string;
  path: string;
  previous: unknown;
  next: unknown;
  dryRun: boolean;
  diff: string;
}

export function setConfigValue(
  file: string,
  path: string,
  rawValue: string,
  options: { dryRun?: boolean } = {},
): SetConfigResult {
  const segments = path.split('.');
  if (findSecretKeys(setPathValue(segments, coerce(rawValue))).length > 0) {
    throw new CrewError('POLICY_DENIED', `Refusing to write a secret-like key (${path}) to configuration`, {
      suggestion: 'Use the system secret store via `crew account add`.',
    });
  }
  const text = existsSync(file) ? readFileSync(file, 'utf8') : 'version: 1\n';
  const doc = parseDocument(text);
  const previous = doc.getIn(segments) as unknown;
  const next = coerce(rawValue);
  doc.setIn(segments, next);
  const output = doc.toString();
  const issues = validateConfigText(output).filter((i) => i.severity === 'error');
  if (issues.length > 0) {
    throw new CrewError('CONFIG_INVALID', `Setting ${path} would make the configuration invalid`, {
      details: { issues },
      retryable: false,
    });
  }
  if (!options.dryRun) {
    ensureDir(dirname(file));
    writeFileSync(file, output, 'utf8');
  }
  return {
    file,
    path,
    previous:
      previous && typeof previous === 'object' && 'toJSON' in previous
        ? (previous as { toJSON(): unknown }).toJSON()
        : previous,
    next,
    dryRun: options.dryRun ?? false,
    diff: `- ${path}: ${JSON.stringify(previous ?? null)}\n+ ${path}: ${JSON.stringify(next)}`,
  };
}
