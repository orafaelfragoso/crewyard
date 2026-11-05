import type { CrewConfig } from '@crewyard/config';
import { type Actor, CrewError, fingerprint, nowIso, type TaskState } from '@crewyard/core';
import { all, type CrewContext, one } from '@crewyard/storage';
import { listWorkspaces, repositoryConfig, requireRepository, type Workspace } from './model.ts';
import { type DestructiveAuthorization, inspectWorkspace, type RemoveResult, removeWorkspace } from './preservation.ts';

export type CleanupBlockReason =
  | 'MANUAL_POLICY'
  | 'WITHIN_RETENTION'
  | 'TASK_NOT_FINISHED'
  | 'LEASE_ACTIVE'
  | 'SESSION_ACTIVE'
  | 'EXECUTION_ACTIVE'
  | 'PR_OPEN'
  | 'NEEDS_RECONCILIATION'
  | 'ALLOCATING';

export interface CleanupItem {
  workspaceId: string;
  path: string;
  branch: string;
  taskId: string | null;
  taskState: TaskState | null;
  cleanupPolicy: Workspace['cleanupPolicy'];
  eligible: boolean;
  blockedBy: CleanupBlockReason[];
  exists: boolean;
  headSha: string | null;
  dirtyFiles: number;
  unpushedCommits: number;
  requiresAuthorization: boolean;
}

export interface CleanupPreview {
  generatedAt: string;
  fingerprint: string;
  items: CleanupItem[];
}

const FINISHED_TASK_STATES: ReadonlySet<TaskState> = new Set(['MERGED', 'DONE', 'CANCELLED']);

export async function previewCleanup(
  ctx: CrewContext,
  options: { repositoryId?: string; config?: CrewConfig } = {},
): Promise<CleanupPreview> {
  const db = ctx.store.db;
  const now = ctx.clock.now().getTime();
  const workspaces = listWorkspaces(ctx, {
    ...(options.repositoryId ? { repositoryId: options.repositoryId } : {}),
    states: ['allocating', 'ready', 'in_use', 'preserved', 'needs_reconciliation'],
  });
  const configs = new Map<string, CrewConfig>();
  const items: CleanupItem[] = [];
  for (const ws of workspaces) {
    const repo = requireRepository(ctx, ws.repositoryId);
    if (!configs.has(repo.id)) configs.set(repo.id, repositoryConfig(ctx, repo, options.config));
    const config = configs.get(repo.id)!;
    const blockedBy: CleanupBlockReason[] = [];
    const task = ws.taskId ? one<{ state: TaskState }>(db, 'SELECT state FROM tasks WHERE id = ?', ws.taskId) : null;
    if (ws.state === 'allocating') blockedBy.push('ALLOCATING');
    if (ws.state === 'needs_reconciliation') blockedBy.push('NEEDS_RECONCILIATION');
    if (ws.cleanupPolicy === 'manual') blockedBy.push('MANUAL_POLICY');
    if (
      ws.cleanupPolicy === 'retention' &&
      now - Date.parse(ws.updatedAt) < config.workspace.retention_days * 86_400_000
    ) {
      blockedBy.push('WITHIN_RETENTION');
    }
    if (task && !FINISHED_TASK_STATES.has(task.state)) blockedBy.push('TASK_NOT_FINISHED');
    if (ws.taskId && one(db, 'SELECT 1 FROM leases WHERE task_id = ? AND released_at IS NULL', ws.taskId)) {
      blockedBy.push('LEASE_ACTIVE');
    }
    if (
      one(db, `SELECT 1 FROM sessions WHERE workspace_id = ? AND state IN ('starting', 'running', 'stopping')`, ws.id)
    ) {
      blockedBy.push('SESSION_ACTIVE');
    }
    if (
      ws.taskId &&
      one(
        db,
        `SELECT 1 FROM execution_claims c JOIN outbox o ON json_extract(o.intent, '$.claim.attemptId') = c.attempt_id
      WHERE o.kind = 'execution.launch' AND o.task_id = ? AND c.released_at IS NULL`,
        ws.taskId,
      )
    )
      blockedBy.push('EXECUTION_ACTIVE');
    const openPr = all<{ id: string }>(
      db,
      `SELECT id FROM pull_requests WHERE repository_id = ? AND state = 'open' AND (head_ref = ? OR (task_id IS NOT NULL AND task_id = ?))`,
      ws.repositoryId,
      ws.branch,
      ws.taskId ?? '',
    );
    if (openPr.length > 0) blockedBy.push('PR_OPEN');
    const inspection = await inspectWorkspace(ctx, ws.id);
    const dirty = inspection.dirtyFiles.length;
    const unpushed = inspection.unpushedCommits.length;
    items.push({
      workspaceId: ws.id,
      path: ws.path,
      branch: ws.branch,
      taskId: ws.taskId,
      taskState: task?.state ?? null,
      cleanupPolicy: ws.cleanupPolicy,
      eligible: blockedBy.length === 0,
      blockedBy,
      exists: inspection.exists,
      headSha: inspection.headSha,
      dirtyFiles: dirty,
      unpushedCommits: unpushed,
      requiresAuthorization: dirty > 0 || unpushed > 0,
    });
  }
  return {
    generatedAt: nowIso(ctx.clock),
    fingerprint: fingerprint(
      items.map((i) => [i.workspaceId, i.eligible, i.exists, i.headSha, i.dirtyFiles, i.unpushedCommits]),
    ),
    items,
  };
}

export interface CleanupApplyResult {
  removed: RemoveResult[];
  skipped: { workspaceId: string; reason: 'AUTHORIZATION_REQUIRED' | CleanupBlockReason }[];
}

export async function applyCleanup(
  ctx: CrewContext,
  input: {
    previewFingerprint: string;
    actor: Actor;
    repositoryId?: string;
    authorization?: DestructiveAuthorization;
    config?: CrewConfig;
  },
): Promise<CleanupApplyResult> {
  const preview = await previewCleanup(ctx, {
    ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
    ...(input.config ? { config: input.config } : {}),
  });
  if (preview.fingerprint !== input.previewFingerprint) {
    throw new CrewError('CONFLICT', 'Workspaces changed since the cleanup preview', {
      suggestion: 'Run `crew workspace cleanup --preview` again and review the new list.',
      retryable: true,
    });
  }
  const result: CleanupApplyResult = { removed: [], skipped: [] };
  for (const item of preview.items) {
    if (!item.eligible) {
      result.skipped.push({ workspaceId: item.workspaceId, reason: item.blockedBy[0]! });
      continue;
    }
    if (item.requiresAuthorization && !input.authorization) {
      result.skipped.push({ workspaceId: item.workspaceId, reason: 'AUTHORIZATION_REQUIRED' });
      continue;
    }
    result.removed.push(
      await removeWorkspace(ctx, item.workspaceId, {
        actor: input.actor,
        deleteBranch: true,
        ...(item.requiresAuthorization && input.authorization ? { authorization: input.authorization } : {}),
      }),
    );
  }
  return result;
}
