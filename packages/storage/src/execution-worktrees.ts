import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CrewError, ensureDir, fingerprint, writeFileAtomic } from '@crewyard/core';
import type { CrewContext } from './context.ts';

export interface ExecutionWorktree {
  kind: 'candidate' | 'review';
  repositoryPath: string;
  path: string;
  attemptId: string;
}

export function assertExecutionWorktreePath(ctx: CrewContext, worktree: ExecutionWorktree, attemptId: string): void {
  const root = resolve(ctx.dirs.worktrees, worktree.kind === 'candidate' ? 'candidates' : 'reviews');
  if (
    !['candidate', 'review'].includes(worktree.kind) ||
    worktree.attemptId !== attemptId ||
    dirname(resolve(worktree.path)) !== root
  )
    throw new CrewError('CONFLICT', 'Disposable worktree manifest does not match this execution attempt');
  if (ctx.store.db.query('SELECT 1 FROM workspaces WHERE path = ?').get(worktree.path))
    throw new CrewError('CONFLICT', 'Task workspaces cannot be removed as disposable execution resources');
}

export function registerExecutionWorktree(ctx: CrewContext, input: Omit<ExecutionWorktree, 'attemptId'>): boolean {
  if (!ctx.execution) return false;
  const worktree: ExecutionWorktree = {
    ...input,
    repositoryPath: resolve(input.repositoryPath),
    path: resolve(input.path),
    attemptId: ctx.execution.claim.attemptId,
  };
  assertExecutionWorktreePath(ctx, worktree, ctx.execution.claim.attemptId);
  const directory = ensureDir(join(ctx.execution.directory, 'worktrees'));
  writeFileAtomic(join(directory, `${fingerprint(worktree)}.json`), JSON.stringify(worktree), { mode: 0o600 });
  return true;
}

export function executionWorktrees(directory: string): ExecutionWorktree[] {
  const path = join(directory, 'worktrees');
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(path, file), 'utf8')) as ExecutionWorktree);
}
