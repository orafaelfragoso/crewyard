import type { Database } from 'bun:sqlite';
import type { RailConfig } from '@agent-rail/config';
import {
  type Actor,
  canonicalPath,
  ensureDir,
  git,
  gitText,
  newId,
  nowIso,
  RailError,
  revParse,
  safeJoin,
} from '@agent-rail/core';
import { exec, one, type RailContext, recordTransition } from '@agent-rail/storage';
import {
  assertManagedWorkspacePath,
  mapWorkspace,
  type RepositoryInfo,
  repositoryConfig,
  requireRepository,
  requireWorkspace,
  type Workspace,
  type WorkspaceRow,
  type WorkspaceState,
} from './model.ts';

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug === '' ? 'work' : slug;
}

export function formatBranchName(format: string, task: { id: string; title: string }): string {
  return format.replaceAll('{task_id}', task.id.toLowerCase()).replaceAll('{slug}', slugify(task.title));
}

async function assertValidBranch(repoPath: string, branch: string): Promise<void> {
  const result = await git(repoPath, ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new RailError('CONFIG_INVALID', `Invalid branch name "${branch}"`, {
      suggestion: 'Fix integration.branch_name_format.',
    });
  }
}

export function hooksDisabledArgs(ctx: RailContext, repo: RepositoryInfo): string[] {
  if (repo.trusted) return [];
  return ['-c', `core.hooksPath=${ensureDir(safeJoin(ctx.dirs.run, 'empty-hooks'))}`];
}

function emit(
  db: Database,
  ws: Pick<Workspace, 'id' | 'taskId'>,
  repo: RepositoryInfo,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
  at: string,
): void {
  recordTransition(
    db,
    { type, actor, projectId: repo.projectId, taskId: ws.taskId, payload: { workspaceId: ws.id, ...payload } },
    { action: type, input: { workspaceId: ws.id, ...payload }, decision: 'accepted' },
    at,
  );
}

export interface AllocateInput {
  taskId: string;
  actor: Actor;
  baseRef?: string;
  baseSha?: string;
  config?: RailConfig;
}

export interface AllocateResult {
  workspace: Workspace;
  reused: boolean;
}

const ACTIVE_STATES: readonly WorkspaceState[] = ['allocating', 'ready', 'in_use', 'preserved', 'needs_reconciliation'];

export async function allocateWorkspace(ctx: RailContext, input: AllocateInput): Promise<AllocateResult> {
  const task = one<{ id: string; title: string; repository_id: string | null; base_branch: string | null }>(
    ctx.store.db,
    'SELECT id, title, repository_id, base_branch FROM tasks WHERE id = ?',
    input.taskId,
  );
  if (!task) throw new RailError('NOT_FOUND', `Task not found: ${input.taskId}`);
  if (!task.repository_id) {
    throw new RailError('INVALID_INPUT', `Task ${task.id} has no repository; no workspace is needed`);
  }
  const existing = one<WorkspaceRow>(
    ctx.store.db,
    `SELECT * FROM workspaces WHERE task_id = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
    task.id,
    ...ACTIVE_STATES,
  );
  if (existing) return { workspace: mapWorkspace(existing), reused: true };

  const repo = requireRepository(ctx, task.repository_id);
  const config = repositoryConfig(ctx, repo, input.config);
  const baseRef = input.baseRef ?? task.base_branch ?? repo.defaultBase;
  const baseSha =
    input.baseSha ??
    (await revParse(repo.canonicalPath, `refs/remotes/origin/${baseRef}`)) ??
    (await revParse(repo.canonicalPath, baseRef));
  if (!baseSha) {
    throw new RailError('NOT_FOUND', `Base ref ${baseRef} not found in ${repo.canonicalPath}`, {
      suggestion: 'Fetch the base branch or set the task base branch.',
    });
  }
  const branch = formatBranchName(config.integration.branch_name_format, task);
  await assertValidBranch(repo.canonicalPath, branch);
  const branchExists = (await revParse(repo.canonicalPath, `refs/heads/${branch}`)) !== null;

  ensureDir(ctx.dirs.worktrees);
  const id = newId('ws');
  const path = safeJoin(canonicalPath(ctx.dirs.worktrees), id);
  const draft: Workspace = {
    id,
    repositoryId: repo.id,
    taskId: task.id,
    path,
    branch,
    baseRef,
    baseSha,
    headSha: null,
    expectedRemoteHead: null,
    state: 'allocating',
    cleanupPolicy: config.workspace.cleanup,
    bootstrapStatus: null,
    createdAt: '',
    updatedAt: '',
  };
  assertManagedWorkspacePath(ctx, draft, repo);
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(
      db,
      `INSERT INTO workspaces (id, repository_id, task_id, path, branch, base_ref, base_sha, state, cleanup_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'allocating', ?, ?, ?)`,
      id,
      repo.id,
      task.id,
      path,
      branch,
      baseRef,
      baseSha,
      config.workspace.cleanup,
      at,
      at,
    );
    emit(db, draft, repo, 'workspace.allocating', input.actor, { branch, baseRef, baseSha, path, branchExists }, at);
  });

  const args = branchExists
    ? ['worktree', 'add', '--', path, branch]
    : ['worktree', 'add', '--no-track', '-b', branch, '--', path, baseSha];
  const result = await git(repo.canonicalPath, [...hooksDisabledArgs(ctx, repo), ...args], { allowFailure: true });
  if (result.exitCode !== 0) {
    ctx.store.immediate((db) => {
      const at = nowIso(ctx.clock);
      exec(db, 'DELETE FROM workspaces WHERE id = ?', id);
      emit(
        db,
        draft,
        repo,
        'workspace.allocation_failed',
        input.actor,
        { error: result.stderr.trim().slice(0, 500) },
        at,
      );
    });
    throw new RailError('EXTERNAL_FAILURE', `git worktree add failed: ${result.stderr.trim().slice(0, 500)}`, {
      retryable: false,
    });
  }
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(db, `UPDATE workspaces SET state = 'ready', head_sha = ?, updated_at = ? WHERE id = ?`, headSha, at, id);
    emit(db, draft, repo, 'workspace.allocated', input.actor, { branch, headSha, reusedBranch: branchExists }, at);
    return { workspace: requireWorkspace(ctx, id), reused: false };
  });
}

const STATE_TRANSITIONS: Readonly<Record<WorkspaceState, readonly WorkspaceState[]>> = {
  allocating: ['ready', 'needs_reconciliation'],
  ready: ['in_use', 'preserved', 'needs_reconciliation', 'cleaned'],
  in_use: ['ready', 'preserved', 'needs_reconciliation', 'cleaned'],
  preserved: ['ready', 'in_use', 'needs_reconciliation', 'cleaned'],
  needs_reconciliation: ['ready', 'preserved', 'cleaned'],
  cleaned: [],
};

export function setWorkspaceState(
  ctx: RailContext,
  workspaceId: string,
  to: WorkspaceState,
  input: { actor: Actor; reason: string },
): Workspace {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const current = requireWorkspace(ctx, workspaceId);
    if (current.state === to) return current;
    if (!STATE_TRANSITIONS[current.state].includes(to)) {
      throw new RailError('INVALID_TRANSITION', `Workspace ${workspaceId} cannot move from ${current.state} to ${to}`, {
        details: { from: current.state, to, allowed: STATE_TRANSITIONS[current.state] },
      });
    }
    exec(db, 'UPDATE workspaces SET state = ?, updated_at = ? WHERE id = ?', to, at, workspaceId);
    emit(
      db,
      current,
      repo,
      'workspace.state_changed',
      input.actor,
      { from: current.state, to, reason: input.reason },
      at,
    );
    return requireWorkspace(ctx, workspaceId);
  });
}

export function markWorkspacesForReconciliation(
  ctx: RailContext,
  input: { taskId: string; actor: Actor; reason: string },
): Workspace[] {
  return ctx.store
    .read(
      (db) =>
        db
          .query(
            `SELECT id FROM workspaces WHERE task_id = ? AND state IN ('allocating', 'ready', 'in_use', 'preserved')`,
          )
          .all(input.taskId) as { id: string }[],
    )
    .map(({ id }) => setWorkspaceState(ctx, id, 'needs_reconciliation', input));
}

export async function recordWorkspaceHead(ctx: RailContext, workspaceId: string, actor: Actor): Promise<Workspace> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    if (headSha !== ws.headSha) {
      exec(db, 'UPDATE workspaces SET head_sha = ?, updated_at = ? WHERE id = ?', headSha, at, workspaceId);
      emit(db, ws, repo, 'workspace.head_recorded', actor, { previous: ws.headSha, headSha }, at);
    }
    return requireWorkspace(ctx, workspaceId);
  });
}

export function setExpectedRemoteHead(
  ctx: RailContext,
  workspaceId: string,
  input: { sha: string; expectedPrevious: string | null; actor: Actor },
): Workspace {
  const repo = requireRepository(ctx, requireWorkspace(ctx, workspaceId).repositoryId);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    const ws = requireWorkspace(ctx, workspaceId);
    if (ws.expectedRemoteHead !== input.expectedPrevious) {
      throw new RailError('HEAD_MISMATCH', `Expected remote head for ${ws.branch} changed concurrently`, {
        details: { expected: input.expectedPrevious, actual: ws.expectedRemoteHead },
        suggestion: 'Reconcile with the observed remote branch before pushing.',
      });
    }
    exec(db, 'UPDATE workspaces SET expected_remote_head = ?, updated_at = ? WHERE id = ?', input.sha, at, workspaceId);
    emit(
      db,
      ws,
      repo,
      'workspace.expected_remote_head',
      input.actor,
      { previous: ws.expectedRemoteHead, sha: input.sha },
      at,
    );
    return requireWorkspace(ctx, workspaceId);
  });
}

export function assertRemoteHeadMatches(
  ctx: RailContext,
  workspaceId: string,
  observedRemoteHead: string | null,
): void {
  const ws = requireWorkspace(ctx, workspaceId);
  if (ws.expectedRemoteHead === observedRemoteHead) return;
  throw new RailError('HEAD_MISMATCH', `Remote branch ${ws.branch} moved outside Agent Rail`, {
    details: { expected: ws.expectedRemoteHead, observed: observedRemoteHead },
    suggestion: 'Treat the remote change as external; reconcile before updating the PR.',
  });
}

export function resolveWorkspacePath(ctx: RailContext, workspaceId: string, relativePath: string): string {
  const ws = requireWorkspace(ctx, workspaceId);
  const root = assertManagedWorkspacePath(ctx, ws, requireRepository(ctx, ws.repositoryId));
  return safeJoin(root, relativePath);
}

export async function writeWorkspaceFile(
  ctx: RailContext,
  workspaceId: string,
  relativePath: string,
  content: string | Uint8Array,
): Promise<string> {
  const target = resolveWorkspacePath(ctx, workspaceId, relativePath);
  await Bun.write(target, content);
  return target;
}
