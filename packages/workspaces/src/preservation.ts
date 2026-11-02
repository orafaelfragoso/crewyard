import { existsSync, rmSync, statSync } from 'node:fs';
import { type Actor, ensureDir, git, gitText, newId, nowIso, RailError, safeJoin, sha256 } from '@agent-rail/core';
import { exec, type RailContext, recordTransition } from '@agent-rail/storage';
import {
  assertManagedWorkspacePath,
  type RepositoryInfo,
  requireRepository,
  requireWorkspace,
  type Workspace,
  type WorkspaceArtifact,
  type WorkspaceArtifactKind,
} from './model.ts';
import { hooksDisabledArgs } from './workspaces.ts';

export interface DirtyFile {
  status: string;
  path: string;
}

export interface WorkspaceInspection {
  workspaceId: string;
  path: string;
  exists: boolean;
  headSha: string | null;
  branch: string | null;
  expectedBranch: string;
  branchMatches: boolean;
  dirtyFiles: DirtyFile[];
  commitsSinceBase: number;
  unpushedCommits: string[];
}

function parsePorcelain(output: string): DirtyFile[] {
  const out: DirtyFile[] = [];
  const records = output.split('\0').filter((r) => r !== '');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const status = record.slice(0, 2);
    out.push({ status: status.trim() || status, path: record.slice(3) });
    if (status.startsWith('R') || status.startsWith('C')) i++;
  }
  return out;
}

async function isWorktree(path: string): Promise<boolean> {
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  const result = await git(path, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}

export async function inspectWorkspace(ctx: RailContext, workspaceId: string): Promise<WorkspaceInspection> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const base: WorkspaceInspection = {
    workspaceId,
    path,
    exists: false,
    headSha: null,
    branch: null,
    expectedBranch: ws.branch,
    branchMatches: false,
    dirtyFiles: [],
    commitsSinceBase: 0,
    unpushedCommits: [],
  };
  if (ws.state === 'cleaned' || !(await isWorktree(path))) return base;
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  const branch =
    (await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })).stdout.trim() || null;
  const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const sinceBase = await gitText(path, ['rev-list', '--count', `${ws.baseSha}..HEAD`]);
  const unpushed = await gitText(path, ['rev-list', 'HEAD', '--not', ws.baseSha, '--remotes']);
  return {
    ...base,
    exists: true,
    headSha,
    branch,
    branchMatches: branch === ws.branch,
    dirtyFiles: parsePorcelain(status.stdout),
    commitsSinceBase: Number(sinceBase),
    unpushedCommits: unpushed === '' ? [] : unpushed.split('\n'),
  };
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface CollectedCommits {
  workspaceId: string;
  taskId: string | null;
  branch: string;
  baseSha: string;
  headSha: string;
  commits: CommitInfo[];
}

export async function collectCommits(ctx: RailContext, workspaceId: string): Promise<CollectedCommits> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  if (!(await isWorktree(path))) {
    throw new RailError('NOT_FOUND', `Workspace ${workspaceId} has no worktree on disk`, { details: { path } });
  }
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  const log = await gitText(path, ['log', '--reverse', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', `${ws.baseSha}..HEAD`]);
  const commits = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter((r) => r !== '')
    .map((record) => {
      const [sha, subject, author, authoredAt] = record.split('\x1f');
      return { sha: sha!, subject: subject ?? '', author: author ?? '', authoredAt: authoredAt ?? '' };
    });
  if (headSha !== ws.headSha) {
    ctx.store.immediate((db) => {
      exec(
        db,
        'UPDATE workspaces SET head_sha = ?, updated_at = ? WHERE id = ?',
        headSha,
        nowIso(ctx.clock),
        workspaceId,
      );
    });
  }
  return { workspaceId, taskId: ws.taskId, branch: ws.branch, baseSha: ws.baseSha, headSha, commits };
}

export interface BackupResult {
  workspaceId: string;
  directory: string;
  headSha: string | null;
  artifacts: WorkspaceArtifact[];
  dirtyFiles: DirtyFile[];
  unpushedCommits: string[];
}

function stamp(at: string): string {
  return at.replace(/[:]/g, '-');
}

export async function backupWorkspace(
  ctx: RailContext,
  workspaceId: string,
  input: { actor: Actor; reason: string },
): Promise<BackupResult> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const inspection = await inspectWorkspace(ctx, workspaceId);
  const at = nowIso(ctx.clock);
  const directory = ensureDir(
    safeJoin(ctx.dirs.artifacts, 'workspaces', workspaceId, `${stamp(at)}-${newId('wsa').slice(-8)}`),
  );
  const created: { kind: WorkspaceArtifactKind; path: string }[] = [];
  if (inspection.exists && inspection.dirtyFiles.length > 0) {
    const patch = safeJoin(directory, 'worktree.patch');
    const index = safeJoin(directory, 'index.tmp');
    const env = { GIT_INDEX_FILE: index };
    try {
      await git(path, ['read-tree', 'HEAD'], { env });
      await git(path, ['add', '-A'], { env });
      await git(path, ['diff', '--cached', '--binary', '--full-index', `--output=${patch}`, 'HEAD'], { env });
    } finally {
      rmSync(index, { force: true });
    }
    created.push({ kind: 'backup_patch', path: patch });
  }
  if (inspection.exists && inspection.unpushedCommits.length > 0) {
    const bundle = safeJoin(directory, 'commits.bundle');
    const ref = inspection.branch ? `refs/heads/${inspection.branch}` : 'HEAD';
    await git(path, ['bundle', 'create', bundle, ref, `^${ws.baseSha}`]);
    created.push({ kind: 'backup_bundle', path: bundle });
  }
  await Bun.write(
    safeJoin(directory, 'manifest.json'),
    JSON.stringify(
      {
        workspaceId,
        taskId: ws.taskId,
        branch: ws.branch,
        baseSha: ws.baseSha,
        headSha: inspection.headSha,
        reason: input.reason,
        createdAt: at,
        dirtyFiles: inspection.dirtyFiles,
        unpushedCommits: inspection.unpushedCommits,
        restore: [
          'git worktree add <dir> <baseSha>',
          'git -C <dir> pull <commits.bundle> <ref>   # when commits.bundle exists',
          'git -C <dir> apply --index <worktree.patch>   # when worktree.patch exists',
        ],
      },
      null,
      2,
    ),
  );
  const artifacts: WorkspaceArtifact[] = [];
  for (const item of created) {
    const digest = sha256(new Uint8Array(await Bun.file(item.path).arrayBuffer()));
    artifacts.push({ id: newId('wsa'), workspaceId, kind: item.kind, path: item.path, sha256: digest, createdAt: at });
  }
  ctx.store.immediate((db) => {
    for (const a of artifacts) {
      exec(
        db,
        'INSERT INTO workspace_artifacts (id, workspace_id, kind, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        a.id,
        a.workspaceId,
        a.kind,
        a.path,
        a.sha256,
        a.createdAt,
      );
    }
    recordTransition(
      db,
      {
        type: 'workspace.backed_up',
        actor: input.actor,
        projectId: repo.projectId,
        taskId: ws.taskId,
        payload: {
          workspaceId,
          reason: input.reason,
          directory,
          artifacts: artifacts.map((a) => ({ kind: a.kind, sha256: a.sha256 })),
          dirtyFiles: inspection.dirtyFiles.length,
          unpushedCommits: inspection.unpushedCommits.length,
        },
      },
      { action: 'workspace.backup', input: { workspaceId, reason: input.reason }, decision: 'accepted' },
      at,
    );
  });
  return {
    workspaceId,
    directory,
    headSha: inspection.headSha,
    artifacts,
    dirtyFiles: inspection.dirtyFiles,
    unpushedCommits: inspection.unpushedCommits,
  };
}

export interface DestructiveAuthorization {
  reason: string;
  approvedBy: Actor;
}

function assertAuthorized(
  inspection: WorkspaceInspection,
  needsAuthorization: boolean,
  authorization: DestructiveAuthorization | undefined,
  action: string,
): void {
  if (!needsAuthorization || authorization) return;
  throw new RailError('POLICY_DENIED', `Refusing to ${action}: workspace has uncommitted or unpushed work`, {
    details: {
      workspaceId: inspection.workspaceId,
      dirtyFiles: inspection.dirtyFiles.length,
      unpushedCommits: inspection.unpushedCommits.length,
    },
    suggestion:
      'Preserve the work, or pass an explicit policy authorization; a recoverable backup is always saved first.',
  });
}

function assertNotLeased(ctx: RailContext, ws: Workspace): void {
  if (!ws.taskId) return;
  const lease = ctx.store.db
    .query('SELECT generation FROM leases WHERE task_id = ? AND released_at IS NULL')
    .get(ws.taskId) as { generation: number } | null;
  if (lease) {
    throw new RailError('CONFLICT', `Workspace ${ws.id} belongs to task ${ws.taskId}, which holds an active lease`, {
      details: { taskId: ws.taskId, generation: lease.generation },
      suggestion: 'Release or reconcile the lease first.',
    });
  }
}

export interface RemoveResult {
  workspace: Workspace;
  backup: BackupResult | null;
  branchDeleted: boolean;
}

export async function removeWorkspace(
  ctx: RailContext,
  workspaceId: string,
  input: { actor: Actor; deleteBranch?: boolean; authorization?: DestructiveAuthorization },
): Promise<RemoveResult> {
  const ws = requireWorkspace(ctx, workspaceId);
  if (ws.state === 'cleaned') return { workspace: ws, backup: null, branchDeleted: false };
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  assertNotLeased(ctx, ws);
  const inspection = await inspectWorkspace(ctx, workspaceId);
  const deleteBranch = input.deleteBranch ?? false;
  assertAuthorized(
    inspection,
    inspection.dirtyFiles.length > 0 || (deleteBranch && inspection.unpushedCommits.length > 0),
    input.authorization,
    'remove the worktree',
  );
  const backup =
    inspection.dirtyFiles.length > 0 || inspection.unpushedCommits.length > 0
      ? await backupWorkspace(ctx, workspaceId, { actor: input.actor, reason: 'before worktree removal' })
      : null;
  const hooks = hooksDisabledArgs(ctx, repo);
  if (inspection.exists) await git(repo.canonicalPath, [...hooks, 'worktree', 'remove', '--force', '--', path]);
  await git(repo.canonicalPath, ['worktree', 'prune']);
  let branchDeleted = false;
  if (deleteBranch) {
    const result = await git(repo.canonicalPath, ['branch', '-D', '--', ws.branch], { allowFailure: true });
    branchDeleted = result.exitCode === 0;
  }
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(db, `UPDATE workspaces SET state = 'cleaned', updated_at = ? WHERE id = ?`, at, workspaceId);
    recordTransition(
      db,
      {
        type: 'workspace.removed',
        actor: input.actor,
        projectId: repo.projectId,
        taskId: ws.taskId,
        payload: {
          workspaceId,
          branch: ws.branch,
          branchDeleted,
          backupDirectory: backup?.directory ?? null,
          authorization: input.authorization?.reason ?? null,
        },
      },
      {
        action: 'workspace.remove',
        input: { workspaceId, deleteBranch },
        decision: input.authorization ? 'authorized' : 'accepted',
      },
      at,
    );
    return { workspace: requireWorkspace(ctx, workspaceId), backup, branchDeleted };
  });
}

export async function resetWorkspace(
  ctx: RailContext,
  workspaceId: string,
  input: { toRef: string; actor: Actor; authorization?: DestructiveAuthorization },
): Promise<{ workspace: Workspace; backup: BackupResult | null; headSha: string }> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo: RepositoryInfo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  assertNotLeased(ctx, ws);
  const inspection = await inspectWorkspace(ctx, workspaceId);
  if (!inspection.exists) throw new RailError('NOT_FOUND', `Workspace ${workspaceId} has no worktree on disk`);
  assertAuthorized(
    inspection,
    inspection.dirtyFiles.length > 0 || inspection.unpushedCommits.length > 0,
    input.authorization,
    'reset the worktree',
  );
  const backup =
    inspection.dirtyFiles.length > 0 || inspection.unpushedCommits.length > 0
      ? await backupWorkspace(ctx, workspaceId, { actor: input.actor, reason: `before reset to ${input.toRef}` })
      : null;
  await git(path, [...hooksDisabledArgs(ctx, repo), 'reset', '--hard', input.toRef]);
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  return ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(db, 'UPDATE workspaces SET head_sha = ?, updated_at = ? WHERE id = ?', headSha, at, workspaceId);
    recordTransition(
      db,
      {
        type: 'workspace.reset',
        actor: input.actor,
        projectId: repo.projectId,
        taskId: ws.taskId,
        payload: { workspaceId, toRef: input.toRef, headSha, backupDirectory: backup?.directory ?? null },
      },
      {
        action: 'workspace.reset',
        input: { workspaceId, toRef: input.toRef },
        decision: input.authorization ? 'authorized' : 'accepted',
      },
      at,
    );
    return { workspace: requireWorkspace(ctx, workspaceId), backup, headSha };
  });
}
