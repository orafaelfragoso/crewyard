import { existsSync, rmSync, statSync } from 'node:fs';
import { type Actor, CrewError, ensureDir, git, gitText, newId, nowIso, safeJoin, sha256 } from '@crewyard/core';
import { all, type CrewContext, exec, recordTransition } from '@crewyard/storage';
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

async function mergedPullRequestHeads(
  ctx: CrewContext,
  path: string,
  ws: { repositoryId: string; branch: string; taskId: string | null },
): Promise<string[]> {
  const heads = all<{ head_sha: string }>(
    ctx.store.db,
    `SELECT DISTINCT head_sha FROM pull_requests WHERE repository_id = ? AND state = 'merged'
       AND (head_ref = ? OR (task_id IS NOT NULL AND task_id = ?))`,
    ws.repositoryId,
    ws.branch,
    ws.taskId ?? '',
  ).map((r) => r.head_sha);
  const present = await Promise.all(
    heads.map(
      async (sha) => (await git(path, ['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true })).exitCode === 0,
    ),
  );
  return heads.filter((_, i) => present[i]);
}

export async function inspectWorkspace(ctx: CrewContext, workspaceId: string): Promise<WorkspaceInspection> {
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
  const merged = await mergedPullRequestHeads(ctx, path, ws);
  const unpushed = await gitText(path, ['rev-list', 'HEAD', '--not', ws.baseSha, '--remotes', ...merged]);
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

export async function collectCommits(ctx: CrewContext, workspaceId: string): Promise<CollectedCommits> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  if (!(await isWorktree(path))) {
    throw new CrewError('NOT_FOUND', `Workspace ${workspaceId} has no worktree on disk`, { details: { path } });
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

export interface CommittedChanges {
  workspaceId: string;
  committed: boolean;
  sha: string | null;
  files: string[];
}

const AGENT_COMMIT_IDENTITY = { name: 'Crewyard agent', email: 'agent@crewyard.invalid' };

async function commitIdentity(path: string): Promise<string[]> {
  const configured = (key: string) => git(path, ['config', '--get', key], { allowFailure: true });
  const [name, email] = await Promise.all([configured('user.name'), configured('user.email')]);
  return [
    ...(name.exitCode === 0 && name.stdout.trim() ? [] : ['-c', `user.name=${AGENT_COMMIT_IDENTITY.name}`]),
    ...(email.exitCode === 0 && email.stdout.trim() ? [] : ['-c', `user.email=${AGENT_COMMIT_IDENTITY.email}`]),
  ];
}

export async function commitWorkspaceChanges(
  ctx: CrewContext,
  workspaceId: string,
  input: { message: string; actor: Actor },
): Promise<CommittedChanges> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const branch = await gitText(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== ws.branch) {
    throw new CrewError('CONFLICT', `Workspace ${workspaceId} is on ${branch}, expected ${ws.branch}`, {
      suggestion: 'Check out the task branch in the worktree before submitting.',
    });
  }
  const files = parsePorcelain(
    (await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
  ).map((f) => f.path);
  if (files.length === 0) return { workspaceId, committed: false, sha: null, files };
  const noHooks = ['-c', `core.hooksPath=${ensureDir(safeJoin(ctx.dirs.run, 'empty-hooks'))}`];
  const identity = await commitIdentity(path);
  await git(path, [...noHooks, 'add', '--all']);
  await git(path, [...noHooks, ...identity, 'commit', '--no-verify', '--quiet', '-m', input.message]);
  const sha = await gitText(path, ['rev-parse', 'HEAD']);
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(db, 'UPDATE workspaces SET head_sha = ?, updated_at = ? WHERE id = ?', sha, at, workspaceId);
    recordTransition(
      db,
      {
        type: 'workspace.changes_committed',
        actor: input.actor,
        projectId: repo.projectId,
        ...(ws.taskId ? { taskId: ws.taskId } : {}),
        payload: { workspaceId, sha, files: files.length },
      },
      { action: 'workspace.commit_changes', input: { workspaceId, files: files.length }, decision: 'accepted' },
      at,
    );
  });
  return { workspaceId, committed: true, sha, files };
}

export interface RemoteBranchUpdate {
  workspaceId: string;
  status: 'current' | 'fast_forward' | 'merged' | 'diverged';
  remoteHead: string | null;
  headSha: string;
  reason: string | null;
}

async function isAncestor(path: string, ancestor: string, descendant: string): Promise<boolean> {
  return (
    (await git(path, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })).exitCode === 0
  );
}

export async function mergeRemoteBranch(
  ctx: CrewContext,
  workspaceId: string,
  input: { actor: Actor },
): Promise<RemoteBranchUpdate> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  const previous = await gitText(path, ['rev-parse', 'HEAD']);
  const listed = await git(path, ['ls-remote', '--heads', 'origin', `refs/heads/${ws.branch}`], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (listed.exitCode !== 0) {
    throw new CrewError('OFFLINE', `Cannot reach origin: ${listed.stderr.trim().slice(0, 300)}`, { retryable: true });
  }
  const remoteHead = listed.stdout.trim().split(/\s+/)[0] || null;
  const result = (status: RemoteBranchUpdate['status'], headSha: string, reason: string | null = null) => ({
    workspaceId,
    status,
    remoteHead,
    headSha,
    reason,
  });
  if (!remoteHead) return result('current', previous);
  const noHooks = hooksDisabledArgs(ctx, repo);
  await git(
    path,
    [
      ...noHooks,
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      `+refs/heads/${ws.branch}:refs/remotes/origin/${ws.branch}`,
    ],
    {
      timeoutMs: 180_000,
    },
  );
  if (await isAncestor(path, remoteHead, previous)) return result('current', previous);
  const dirty = parsePorcelain(
    (await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout,
  ).length;
  if (dirty > 0) return result('diverged', previous, `${dirty} uncommitted file(s) in the worktree`);
  const fastForward = await isAncestor(path, previous, remoteHead);
  const merge = await git(
    path,
    fastForward
      ? [...noHooks, 'merge', '--ff-only', '--quiet', remoteHead]
      : [
          ...noHooks,
          ...(await commitIdentity(path)),
          'merge',
          '--no-ff',
          '--no-edit',
          '--quiet',
          '-m',
          `Merge origin/${ws.branch} into ${ws.branch}`,
          remoteHead,
        ],
    { allowFailure: true },
  );
  if (merge.exitCode !== 0) {
    await git(path, ['merge', '--abort'], { allowFailure: true });
    return result('diverged', previous, `merging origin/${ws.branch} conflicts: ${merge.stderr.trim().slice(0, 300)}`);
  }
  const headSha = await gitText(path, ['rev-parse', 'HEAD']);
  const status = fastForward ? 'fast_forward' : 'merged';
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    exec(db, 'UPDATE workspaces SET head_sha = ?, updated_at = ? WHERE id = ?', headSha, at, workspaceId);
    recordTransition(
      db,
      {
        type: 'workspace.remote_merged',
        actor: input.actor,
        projectId: repo.projectId,
        ...(ws.taskId ? { taskId: ws.taskId } : {}),
        payload: { workspaceId, previous, remoteHead, headSha, status },
      },
      { action: 'workspace.merge_remote', input: { workspaceId, remoteHead }, decision: status },
      at,
    );
  });
  return result(status, headSha);
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
  ctx: CrewContext,
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
  throw new CrewError('POLICY_DENIED', `Refusing to ${action}: workspace has uncommitted or unpushed work`, {
    details: {
      workspaceId: inspection.workspaceId,
      dirtyFiles: inspection.dirtyFiles.length,
      unpushedCommits: inspection.unpushedCommits.length,
    },
    suggestion:
      'Preserve the work, or pass an explicit policy authorization; a recoverable backup is always saved first.',
  });
}

function assertNotLeased(ctx: CrewContext, ws: Workspace): void {
  if (!ws.taskId) return;
  const lease = ctx.store.db
    .query('SELECT generation FROM leases WHERE task_id = ? AND released_at IS NULL')
    .get(ws.taskId) as { generation: number } | null;
  if (lease) {
    throw new CrewError('CONFLICT', `Workspace ${ws.id} belongs to task ${ws.taskId}, which holds an active lease`, {
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
  ctx: CrewContext,
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
  ctx: CrewContext,
  workspaceId: string,
  input: { toRef: string; actor: Actor; authorization?: DestructiveAuthorization },
): Promise<{ workspace: Workspace; backup: BackupResult | null; headSha: string }> {
  const ws = requireWorkspace(ctx, workspaceId);
  const repo: RepositoryInfo = requireRepository(ctx, ws.repositoryId);
  const path = assertManagedWorkspacePath(ctx, ws, repo);
  assertNotLeased(ctx, ws);
  const inspection = await inspectWorkspace(ctx, workspaceId);
  if (!inspection.exists) throw new CrewError('NOT_FOUND', `Workspace ${workspaceId} has no worktree on disk`);
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
