import type { RailConfig } from '@agent-rail/config';
import {
  type Actor,
  DEFAULT_ENV_ALLOWLIST,
  ensureDir,
  fingerprint,
  newId,
  nowIso,
  RailError,
  REDACTED,
  redact,
  safeJoin,
  sha256,
  shellCommand,
} from '@agent-rail/core';
import { exec, one, type RailContext, recordTransition } from '@agent-rail/storage';
import { runBounded } from './bounded.ts';
import { assertManagedWorkspacePath, repositoryConfig, requireRepository, requireWorkspace } from './model.ts';

export type SecretResolver = (ref: string) => Promise<string | null>;

export interface BootstrapCommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  logArtifactId: string;
}

export interface BootstrapResult {
  workspaceId: string;
  status: 'skipped' | 'succeeded' | 'failed';
  commands: BootstrapCommandResult[];
}

export function secretEnvName(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(REDACTED);
  return redact(out);
}

function ensureHookApproval(
  ctx: RailContext,
  repo: { id: string; projectId: string },
  commands: readonly string[],
  actor: Actor,
): void {
  const subjectId = `${repo.id}@${fingerprint(commands).slice(0, 16)}`;
  const outcome = ctx.store.immediate((db) => {
    const latest = one<{ id: string; status: 'pending' | 'approved' | 'rejected' }>(
      db,
      `SELECT id, status FROM approvals WHERE subject_kind = 'repo_hooks' AND subject_id = ?
       ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1`,
      subjectId,
    );
    if (latest?.status === 'approved') return { approved: true, approvalId: latest.id, status: latest.status };
    if (latest?.status === 'pending') return { approved: false, approvalId: latest.id, status: latest.status };
    const at = nowIso(ctx.clock);
    const id = newId('apr');
    exec(
      db,
      `INSERT INTO approvals (id, project_id, subject_kind, subject_id, reason, status, requested_by, created_at)
       VALUES (?, ?, 'repo_hooks', ?, ?, 'pending', ?, ?)`,
      id,
      repo.projectId,
      subjectId,
      `Run ${commands.length} repository-defined bootstrap command(s) in an untrusted repository: ${commands.join(' && ').slice(0, 400)}`,
      `${actor.kind}:${actor.id}`,
      at,
    );
    recordTransition(
      db,
      {
        type: 'approval.requested',
        actor,
        projectId: repo.projectId,
        payload: { approvalId: id, subjectKind: 'repo_hooks', subjectId, commands },
      },
      { action: 'approval.request', input: { subjectKind: 'repo_hooks', subjectId }, decision: 'pending' },
      at,
    );
    return { approved: false, approvalId: id, status: 'pending' as const };
  });
  if (outcome.approved) return;
  throw new RailError('APPROVAL_REQUIRED', 'Repository is untrusted; bootstrap commands need operator approval', {
    details: { approvalId: outcome.approvalId, subjectId, status: outcome.status, commands },
    suggestion: `Approve ${outcome.approvalId} or mark the repository trusted.`,
  });
}

export async function bootstrapWorkspace(
  ctx: RailContext,
  workspaceId: string,
  input: { actor: Actor; resolveSecret: SecretResolver; config?: RailConfig; maxOutputBytes?: number },
): Promise<BootstrapResult> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const config = repositoryConfig(ctx, repo, input.config);
  const commands = [...config.workspace.setup_commands, ...config.workspace.install_commands];
  const setStatus = (status: string, payload: Record<string, unknown>) =>
    ctx.store.immediate((db) => {
      const at = nowIso(ctx.clock);
      exec(db, 'UPDATE workspaces SET bootstrap_status = ?, updated_at = ? WHERE id = ?', status, at, workspaceId);
      recordTransition(
        db,
        {
          type: `workspace.bootstrap_${status}`,
          actor: input.actor,
          projectId: repo.projectId,
          taskId: ws.taskId,
          payload: { workspaceId, ...payload },
        },
        { action: 'workspace.bootstrap', input: { workspaceId, commands }, decision: status },
        at,
      );
    });
  if (commands.length === 0) {
    setStatus('skipped', {});
    return { workspaceId, status: 'skipped', commands: [] };
  }
  if (!repo.trusted) ensureHookApproval(ctx, repo, commands, input.actor);

  const secrets: Record<string, string> = {};
  for (const ref of config.workspace.secret_refs) {
    const value = await input.resolveSecret(ref);
    if (value === null) {
      throw new RailError('NOT_FOUND', `Secret reference ${ref} could not be resolved`, {
        suggestion: 'Store it in the system secret store or remove it from workspace.secret_refs.',
      });
    }
    secrets[secretEnvName(ref)] = value;
  }
  const secretValues = Object.values(secrets);
  setStatus('running', { commands: commands.length });
  const logDir = ensureDir(safeJoin(ctx.dirs.artifacts, 'workspaces', workspaceId, 'bootstrap'));
  const results: BootstrapCommandResult[] = [];
  let failed = false;
  for (const [index, command] of commands.entries()) {
    const shell = shellCommand(command);
    const run = await runBounded(shell.argv, {
      verbatimArguments: shell.verbatimArguments,
      cwd: path,
      permittedRoots: [path],
      envAllowlist: [...DEFAULT_ENV_ALLOWLIST, ...config.workspace.env_allowlist],
      env: secrets,
      timeoutMs: config.workspace.timeout_seconds * 1000,
      maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
      network: config.security.network,
    });
    const at = nowIso(ctx.clock);
    const logPath = safeJoin(logDir, `${String(index + 1).padStart(2, '0')}-${at.replace(/:/g, '-')}.log`);
    const log = scrub(
      `$ ${command}\n# exit=${run.exitCode} timedOut=${run.timedOut} truncated=${run.truncated} durationMs=${run.durationMs}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}\n`,
      secretValues,
    );
    await Bun.write(logPath, log);
    const artifactId = newId('wsa');
    ctx.store.immediate((db) => {
      exec(
        db,
        `INSERT INTO workspace_artifacts (id, workspace_id, kind, path, sha256, created_at) VALUES (?, ?, 'bootstrap_log', ?, ?, ?)`,
        artifactId,
        workspaceId,
        logPath,
        sha256(log),
        at,
      );
    });
    results.push({
      command,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      truncated: run.truncated,
      durationMs: run.durationMs,
      logArtifactId: artifactId,
    });
    if (run.exitCode !== 0) {
      failed = true;
      break;
    }
  }
  const status = failed ? 'failed' : 'succeeded';
  setStatus(status, {
    results: results.map((r) => ({ command: r.command, exitCode: r.exitCode, timedOut: r.timedOut })),
  });
  return { workspaceId, status, commands: results };
}
