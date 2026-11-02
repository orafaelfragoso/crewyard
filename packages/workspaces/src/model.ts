import { type CrewConfig, loadConfig } from '@crewyard/config';
import { CrewError, canonicalPath, isWithin } from '@crewyard/core';
import { all, type CrewContext, one } from '@crewyard/storage';

export type WorkspaceState = 'allocating' | 'ready' | 'in_use' | 'preserved' | 'needs_reconciliation' | 'cleaned';
export type CleanupPolicy = 'after_merge' | 'manual' | 'retention';
export type WorkspaceArtifactKind = 'backup_patch' | 'backup_bundle' | 'log' | 'test_output' | 'bootstrap_log';

export interface Workspace {
  id: string;
  repositoryId: string;
  taskId: string | null;
  path: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string | null;
  expectedRemoteHead: string | null;
  state: WorkspaceState;
  cleanupPolicy: CleanupPolicy;
  bootstrapStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRow {
  id: string;
  repository_id: string;
  task_id: string | null;
  path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  head_sha: string | null;
  expected_remote_head: string | null;
  state: WorkspaceState;
  cleanup_policy: CleanupPolicy;
  bootstrap_status: string | null;
  created_at: string;
  updated_at: string;
}

export function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    taskId: row.task_id,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    expectedRemoteHead: row.expected_remote_head,
    state: row.state,
    cleanupPolicy: row.cleanup_policy,
    bootstrapStatus: row.bootstrap_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WorkspaceArtifact {
  id: string;
  workspaceId: string;
  kind: WorkspaceArtifactKind;
  path: string;
  sha256: string | null;
  createdAt: string;
}

export interface WorkspaceArtifactRow {
  id: string;
  workspace_id: string;
  kind: WorkspaceArtifactKind;
  path: string;
  sha256: string | null;
  created_at: string;
}

export function mapArtifact(row: WorkspaceArtifactRow): WorkspaceArtifact {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    path: row.path,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export interface RepositoryInfo {
  id: string;
  projectId: string;
  projectName: string;
  canonicalPath: string;
  defaultBase: string;
  trusted: boolean;
}

export function requireRepository(ctx: CrewContext, repositoryId: string): RepositoryInfo {
  const row = one<{
    id: string;
    project_id: string;
    name: string;
    canonical_path: string;
    default_base: string;
    trusted: number;
  }>(
    ctx.store.db,
    `SELECT r.id, r.project_id, p.name, r.canonical_path, r.default_base, r.trusted
     FROM repositories r JOIN projects p ON p.id = r.project_id WHERE r.id = ?`,
    repositoryId,
  );
  if (!row) throw new CrewError('NOT_FOUND', `Repository not found: ${repositoryId}`);
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.name,
    canonicalPath: row.canonical_path,
    defaultBase: row.default_base,
    trusted: row.trusted === 1,
  };
}

export function repositoryConfig(ctx: CrewContext, repo: RepositoryInfo, config?: CrewConfig): CrewConfig {
  return (
    config ?? loadConfig({ repoRoot: repo.canonicalPath, dirs: ctx.dirs, projectNameFallback: repo.projectName }).config
  );
}

export function requireWorkspace(ctx: CrewContext, workspaceId: string): Workspace {
  const row = one<WorkspaceRow>(ctx.store.db, 'SELECT * FROM workspaces WHERE id = ?', workspaceId);
  if (!row)
    throw new CrewError('NOT_FOUND', `Workspace not found: ${workspaceId}`, {
      suggestion: 'Run `crew workspace list`.',
    });
  return mapWorkspace(row);
}

export function getWorkspace(ctx: CrewContext, workspaceId: string): Workspace {
  return requireWorkspace(ctx, workspaceId);
}

export function listWorkspaces(
  ctx: CrewContext,
  filter: { repositoryId?: string; taskId?: string; states?: WorkspaceState[] } = {},
): Workspace[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.repositoryId) {
    where.push('repository_id = ?');
    params.push(filter.repositoryId);
  }
  if (filter.taskId) {
    where.push('task_id = ?');
    params.push(filter.taskId);
  }
  if (filter.states && filter.states.length > 0) {
    where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
    params.push(...filter.states);
  }
  return all<WorkspaceRow>(
    ctx.store.db,
    `SELECT * FROM workspaces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, id`,
    ...params,
  ).map(mapWorkspace);
}

export function listWorkspaceArtifacts(ctx: CrewContext, workspaceId: string): WorkspaceArtifact[] {
  return all<WorkspaceArtifactRow>(
    ctx.store.db,
    'SELECT * FROM workspace_artifacts WHERE workspace_id = ? ORDER BY created_at, id',
    workspaceId,
  ).map(mapArtifact);
}

export function assertManagedWorkspacePath(ctx: CrewContext, workspace: Workspace, repo: RepositoryInfo): string {
  const path = canonicalPath(workspace.path);
  const root = canonicalPath(ctx.dirs.worktrees);
  if (
    path === root ||
    !isWithin(root, path) ||
    isWithin(path, repo.canonicalPath) ||
    isWithin(repo.canonicalPath, path)
  ) {
    throw new CrewError('POLICY_DENIED', `Workspace path ${workspace.path} is not a managed worktree`, {
      details: { workspaceId: workspace.id, worktreesRoot: root },
      suggestion: 'Crewyard only modifies worktrees under its managed data root, never the primary checkout.',
    });
  }
  return path;
}
