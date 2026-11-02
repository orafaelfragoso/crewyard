import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RailConfig } from '@agent-rail/config';
import {
  type Actor,
  ensureDir,
  type FailureClass,
  fingerprint,
  newId,
  nowIso,
  RailError,
  redact,
  run,
  SYSTEM_ACTOR,
  sanitizeEnv,
  sha256,
  shellCommand,
} from '@agent-rail/core';
import { one, type RailContext, recordTransition, toJson } from '@agent-rail/storage';
import { matchesAny } from './classify.ts';

export type CommandSpec = RailConfig['validation']['fast'][number];
export type ValidationScope = 'fast' | 'broad' | 'required';
export type ValidationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export function selectValidation(
  config: Pick<RailConfig, 'validation'>,
  scope: 'fast' | 'broad',
  changedPaths: readonly string[],
): CommandSpec[] {
  if (scope === 'broad') return [...config.validation.broad];
  return config.validation.fast.filter(
    (spec) => spec.paths.length === 0 || changedPaths.some((path) => matchesAny(spec.paths, path)),
  );
}

export interface ValidationRun {
  id: string;
  repositoryId: string;
  prId: string | null;
  candidateId: string | null;
  taskId: string | null;
  scope: ValidationScope;
  commands: { name: string; command: string; exitCode: number | null; durationMs: number; timedOut: boolean }[];
  envFingerprint: string;
  commitSha: string;
  treeSha: string | null;
  status: ValidationStatus;
  exitCode: number | null;
  durationMs: number | null;
  outputRef: string | null;
  failureFingerprint: string | null;
  failureClass: FailureClass | null;
  createdAt: string;
  completedAt: string | null;
}

interface ValidationRow {
  id: string;
  repository_id: string;
  pr_id: string | null;
  candidate_id: string | null;
  task_id: string | null;
  scope: ValidationScope;
  commands: string;
  env_fingerprint: string;
  commit_sha: string;
  tree_sha: string | null;
  status: ValidationStatus;
  exit_code: number | null;
  duration_ms: number | null;
  output_ref: string | null;
  failure_fingerprint: string | null;
  failure_class: FailureClass | null;
  created_at: string;
  completed_at: string | null;
}

const mapRun = (r: ValidationRow): ValidationRun => ({
  id: r.id,
  repositoryId: r.repository_id,
  prId: r.pr_id,
  candidateId: r.candidate_id,
  taskId: r.task_id,
  scope: r.scope,
  commands: JSON.parse(r.commands) as ValidationRun['commands'],
  envFingerprint: r.env_fingerprint,
  commitSha: r.commit_sha,
  treeSha: r.tree_sha,
  status: r.status,
  exitCode: r.exit_code,
  durationMs: r.duration_ms,
  outputRef: r.output_ref,
  failureFingerprint: r.failure_fingerprint,
  failureClass: r.failure_class,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});

export function environmentFingerprint(env: Record<string, string>): string {
  const values = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key !== 'HOME' && key !== 'TMPDIR' && key !== 'TEMP' && key !== 'TMP')
      .map(([key, value]) => [key, sha256(value)]),
  );
  return fingerprint({ platform: process.platform, arch: process.arch, bun: Bun.version, env: values });
}

export function normalizeFailureOutput(output: string): string {
  return output
    .split('\n')
    .slice(-40)
    .join('\n')
    .replace(/\b[0-9a-f]{7,64}\b/g, '<sha>')
    .replace(/(\/[\w.-]+)+\/(rail-[\w-]+|tmp[\w-]*)[\w/.-]*/g, '<path>')
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '<duration>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<time>')
    .trim();
}

export function classifyValidationFailure(name: string, timedOut: boolean): FailureClass {
  if (timedOut) return 'transient_ci';
  if (/type|tsc|build|compile|lint/i.test(name)) return 'compilation';
  return 'test_failure';
}

export interface RunValidationInput {
  repositoryId: string;
  prId?: string | null;
  candidateId?: string | null;
  taskId?: string | null;
  scope: ValidationScope;
  cwd: string;
  commitSha: string;
  treeSha?: string | null;
  commands: readonly CommandSpec[];
  envAllowlist?: readonly string[];
  actor?: Actor;
}

export async function runValidation(ctx: RailContext, input: RunValidationInput): Promise<ValidationRun> {
  const actor = input.actor ?? SYSTEM_ACTOR;
  const env = sanitizeEnv(process.env, undefined, {});
  for (const key of input.envAllowlist ?? []) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const envFingerprint = environmentFingerprint(env);
  const id = newId('val');
  const outputDir = ensureDir(join(ctx.dirs.artifacts, 'validation'));
  const outputRef = join(outputDir, `${id}.log`);
  const startedAt = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    db.query(
      `INSERT INTO validation_runs (id, repository_id, pr_id, candidate_id, task_id, scope, commands, env_fingerprint, commit_sha, tree_sha, status, output_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    ).run(
      id,
      input.repositoryId,
      input.prId ?? null,
      input.candidateId ?? null,
      input.taskId ?? null,
      input.scope,
      toJson(input.commands.map((c) => ({ name: c.name, command: c.command }))),
      envFingerprint,
      input.commitSha,
      input.treeSha ?? null,
      outputRef,
      startedAt,
    );
  });
  const results: ValidationRun['commands'] = [];
  let status: ValidationStatus = 'passed';
  let exitCode: number | null = 0;
  let failureFingerprint: string | null = null;
  let failureClass: FailureClass | null = null;
  let total = 0;
  for (const spec of input.commands) {
    appendFileSync(outputRef, `$ ${spec.name}: ${spec.command}\n`);
    try {
      const shell = shellCommand(spec.command);
      const result = await run(shell.argv, {
        verbatimArguments: shell.verbatimArguments,
        cwd: input.cwd,
        env,
        timeoutMs: spec.timeout_seconds * 1000,
        allowFailure: true,
        maxOutputBytes: 4 * 1024 * 1024,
      });
      total += result.durationMs;
      const output = redact(`${result.stdout}${result.stderr}`);
      appendFileSync(outputRef, `${output}\n[exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}]\n`);
      results.push({
        name: spec.name,
        command: spec.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        status = 'failed';
        exitCode = result.exitCode;
        failureClass = classifyValidationFailure(spec.name, result.timedOut);
        failureFingerprint = fingerprint({
          scope: input.scope,
          command: spec.name,
          exitCode: result.exitCode,
          failureClass,
          output: normalizeFailureOutput(output),
        });
        break;
      }
    } catch (error) {
      status = 'error';
      exitCode = null;
      failureClass = 'unknown';
      const message = error instanceof RailError ? error.message : String(error);
      appendFileSync(outputRef, `${redact(message)}\n`);
      failureFingerprint = fingerprint({ scope: input.scope, command: spec.name, error: message });
      results.push({ name: spec.name, command: spec.command, exitCode: null, durationMs: 0, timedOut: false });
      break;
    }
  }
  const completedAt = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    db.query(
      `UPDATE validation_runs SET status = ?, exit_code = ?, duration_ms = ?, commands = ?, failure_fingerprint = ?, failure_class = ?, completed_at = ? WHERE id = ?`,
    ).run(status, exitCode, total, toJson(results), failureFingerprint, failureClass, completedAt, id);
    recordTransition(
      db,
      {
        type: 'validation.completed',
        actor,
        taskId: input.taskId ?? null,
        prId: input.prId ?? null,
        payload: {
          validationId: id,
          scope: input.scope,
          status,
          commitSha: input.commitSha,
          treeSha: input.treeSha ?? null,
          candidateId: input.candidateId ?? null,
        },
      },
      { action: 'validation.run', input: { commands: results.map((r) => r.name) }, decision: status },
      completedAt,
    );
    return mapRun(one<ValidationRow>(db, 'SELECT * FROM validation_runs WHERE id = ?', id)!);
  });
}

export function getValidationRun(ctx: RailContext, id: string): ValidationRun {
  const row = one<ValidationRow>(ctx.store.db, 'SELECT * FROM validation_runs WHERE id = ?', id);
  if (!row) throw new RailError('NOT_FOUND', `Validation run not found: ${id}`);
  return mapRun(row);
}

export function latestValidation(
  ctx: RailContext,
  query: { candidateId?: string; prId?: string; commitSha?: string },
): ValidationRun | null {
  const row = one<ValidationRow>(
    ctx.store.db,
    `SELECT * FROM validation_runs WHERE (? IS NULL OR candidate_id = ?) AND (? IS NULL OR pr_id = ?) AND (? IS NULL OR commit_sha = ?)
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    query.candidateId ?? null,
    query.candidateId ?? null,
    query.prId ?? null,
    query.prId ?? null,
    query.commitSha ?? null,
    query.commitSha ?? null,
  );
  return row ? mapRun(row) : null;
}
