import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type Actor, CrewError, gitText, sha256 } from '@crewyard/core';
import { registerProject } from '@crewyard/projects';
import { addTask, decideApproval, transitionTask } from '@crewyard/tasks';
import {
  allocateWorkspace,
  applyCleanup,
  bootstrapWorkspace,
  collectCommits,
  commitWorkspaceChanges,
  inspectWorkspace,
  listWorkspaceArtifacts,
  markWorkspacesForReconciliation,
  platformLimitations,
  previewCleanup,
  removeWorkspace,
  resolveWorkspacePath,
  runBounded,
  writeWorkspaceFile,
} from '@crewyard/workspaces';
import {
  commitFiles,
  createTempGitRepo,
  createTestContext,
  type TestContext,
  tempDir,
  writeFiles,
} from '../helpers/index.ts';
import { testConfig } from '../unit/tasks/fixtures.ts';

const operator: Actor = { kind: 'operator', id: 'rafael' };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function setup(config = testConfig()) {
  const ctx: TestContext = createTestContext();
  const repo = await createTempGitRepo({ 'README.md': '# primary\n', 'src/app.ts': 'export const v = 1;\n' });
  cleanups.push(() => {
    ctx.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });
  const { project, repository } = await registerProject(ctx, { repoPath: repo, baseBranch: 'main', actor: operator });
  const newTask = (title: string) =>
    addTask(ctx, { projectId: project.id, repositoryId: repository.id, title, actor: operator }, { config });
  return { ctx, repo, project, repository, newTask, config };
}

function errorOf(error: unknown): CrewError {
  if (error instanceof CrewError) return error;
  throw error;
}

async function rejection(promise: Promise<unknown>): Promise<CrewError> {
  try {
    await promise;
  } catch (error) {
    return errorOf(error);
  }
  throw new Error('expected the operation to fail');
}

async function primarySnapshot(repo: string) {
  return {
    status: await gitText(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    head: await gitText(repo, ['rev-parse', 'HEAD']),
    branch: await gitText(repo, ['symbolic-ref', '--short', 'HEAD']),
    files: sha256(readFileSync(join(repo, 'README.md'), 'utf8') + readFileSync(join(repo, 'src/app.ts'), 'utf8')),
  };
}

const posix = process.platform !== 'win32';

describe('workspaces', () => {
  test('three tasks modify separate worktrees while the primary checkout stays byte-identical', async () => {
    const { ctx, repo, newTask, config } = await setup();
    const before = await primarySnapshot(repo);
    const workspaces = [];
    for (const title of ['Add login', 'Add search', 'Fix typo']) {
      const task = newTask(title);
      workspaces.push((await allocateWorkspace(ctx, { taskId: task.id, actor: operator, config })).workspace);
    }
    expect(workspaces.map((w) => w.branch)).toEqual([
      'crew/task-1-add-login',
      'crew/task-2-add-search',
      'crew/task-3-fix-typo',
    ]);
    expect(new Set(workspaces.map((w) => w.baseSha))).toEqual(new Set([before.head]));

    const [a, b, c] = workspaces;
    await commitFiles(a!.path, { 'src/login.ts': 'export {};\n' }, 'login');
    await commitFiles(b!.path, { 'src/app.ts': 'export const v = 2;\n' }, 'search');
    writeFiles(c!.path, { 'README.md': '# typo fixed\n' });

    expect(await primarySnapshot(repo)).toEqual(before);
    expect((await collectCommits(ctx, a!.id)).commits.map((x) => x.subject)).toEqual(['login']);
    expect((await collectCommits(ctx, b!.id)).commits.map((x) => x.subject)).toEqual(['search']);
    expect((await inspectWorkspace(ctx, c!.id)).dirtyFiles).toEqual([{ status: 'M', path: 'README.md' }]);
    expect((await allocateWorkspace(ctx, { taskId: a!.taskId!, actor: operator, config })).reused).toBe(true);
  });

  test('AT-02: a crash before handoff leaves commits and edits intact and attributable', async () => {
    const { ctx, newTask, config } = await setup();
    const task = newTask('Crashy');
    const { workspace } = await allocateWorkspace(ctx, { taskId: task.id, actor: operator, config });
    const sha = await commitFiles(workspace.path, { 'src/feature.ts': 'export const f = 1;\n' }, 'feature');
    writeFiles(workspace.path, { 'notes.md': 'unsaved\n' });

    const marked = markWorkspacesForReconciliation(ctx, { taskId: task.id, actor: operator, reason: 'agent crashed' });
    expect(marked.map((w) => w.state)).toEqual(['needs_reconciliation']);
    const collected = await collectCommits(ctx, workspace.id);
    expect(collected).toMatchObject({ taskId: task.id, headSha: sha });
    expect(collected.commits.map((c) => c.sha)).toEqual([sha]);
    expect((await inspectWorkspace(ctx, workspace.id)).dirtyFiles).toEqual([{ status: '??', path: 'notes.md' }]);
    const preview = await previewCleanup(ctx, { config });
    expect(preview.items[0]).toMatchObject({ eligible: false });
    expect(preview.items[0]?.blockedBy).toContain('NEEDS_RECONCILIATION');
  });

  test('cleanup previews first, refuses dirty work without authorization and saves recoverable backups', async () => {
    const { ctx, repo, newTask, config } = await setup();
    const task = newTask('Abandoned');
    const { workspace } = await allocateWorkspace(ctx, { taskId: task.id, actor: operator, config });
    const committed = await commitFiles(workspace.path, { 'src/new.ts': 'export const n = 1;\n' }, 'unpushed work');
    writeFiles(workspace.path, { 'src/app.ts': 'export const v = 3;\n', 'untracked.txt': 'keep me\n' });
    transitionTask(ctx, { taskId: task.id, to: 'CANCELLED', actor: operator, reason: 'abandoned' });

    const denied = await removeWorkspace(ctx, workspace.id, { actor: operator }).catch(errorOf);
    expect(denied).toMatchObject({ code: 'POLICY_DENIED' });

    const preview = await previewCleanup(ctx, { config });
    expect(preview.items).toMatchObject([{ workspaceId: workspace.id, eligible: true, requiresAuthorization: true }]);
    expect(
      await applyCleanup(ctx, { previewFingerprint: 'stale', actor: operator, config }).catch(errorOf),
    ).toMatchObject({ code: 'CONFLICT' });
    const skipped = await applyCleanup(ctx, { previewFingerprint: preview.fingerprint, actor: operator, config });
    expect(skipped.skipped).toEqual([{ workspaceId: workspace.id, reason: 'AUTHORIZATION_REQUIRED' }]);

    const applied = await applyCleanup(ctx, {
      previewFingerprint: preview.fingerprint,
      actor: operator,
      config,
      authorization: { reason: 'task abandoned', approvedBy: operator },
    });
    expect(applied.removed.map((r) => [r.workspace.state, r.branchDeleted])).toEqual([['cleaned', true]]);
    const artifacts = listWorkspaceArtifacts(ctx, workspace.id);
    expect(artifacts.map((a) => a.kind).sort()).toEqual(['backup_bundle', 'backup_patch']);

    const restore = join(tempDir('crew-restore-'), 'wt');
    cleanups.push(() => rmSync(restore, { recursive: true, force: true }));
    const bundle = artifacts.find((a) => a.kind === 'backup_bundle')!.path;
    const patch = artifacts.find((a) => a.kind === 'backup_patch')!.path;
    await gitText(repo, ['worktree', 'add', '--detach', restore, workspace.baseSha]);
    await gitText(restore, ['fetch', '-q', bundle, `refs/heads/${workspace.branch}`]);
    await gitText(restore, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    expect(await gitText(restore, ['rev-parse', 'HEAD'])).toBe(committed);
    await gitText(restore, ['apply', '--index', patch]);
    expect(readFileSync(join(restore, 'untracked.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(restore, 'src/app.ts'), 'utf8')).toBe('export const v = 3;\n');
    expect(await gitText(repo, ['status', '--porcelain=v1'])).toBe('');
  }, 30_000);

  test.skipIf(!posix)('path traversal and symlink escapes are rejected for workspace file operations', async () => {
    const { ctx, newTask, config } = await setup();
    const { workspace } = await allocateWorkspace(ctx, { taskId: newTask('Paths').id, actor: operator, config });
    const outside = tempDir('crew-outside-');
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(workspace.path, 'nested'));
    symlinkSync(outside, join(workspace.path, 'nested', 'escape'));

    expect(() => resolveWorkspacePath(ctx, workspace.id, '../../etc/passwd')).toThrow(CrewError);
    expect(await writeWorkspaceFile(ctx, workspace.id, 'nested/escape/pwned.txt', 'x').catch(errorOf)).toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(await writeWorkspaceFile(ctx, workspace.id, 'nested/ok.txt', 'ok')).toBe(
      join(workspace.path, 'nested/ok.txt'),
    );
    expect(
      await runBounded(['pwd'], {
        cwd: outside,
        permittedRoots: [workspace.path],
        timeoutMs: 5_000,
        maxOutputBytes: 1024,
      }).catch(errorOf),
    ).toMatchObject({ code: 'POLICY_DENIED' });
  });

  test.skipIf(!posix)(
    'bootstrap of an untrusted repository requires approval and never leaks resolved secrets',
    async () => {
      const config = testConfig({
        workspace: {
          setup_commands: ['printf "token=$NPM_TOKEN" > boot.txt; echo "using $NPM_TOKEN"'],
          secret_refs: ['npm-token'],
        },
      });
      const { ctx, newTask } = await setup(config);
      const { workspace } = await allocateWorkspace(ctx, { taskId: newTask('Boot').id, actor: operator, config });
      const resolveSecret = async (ref: string) => (ref === 'npm-token' ? 'npm_SuperSecretValue123' : null);

      const denied = await rejection(bootstrapWorkspace(ctx, workspace.id, { actor: operator, resolveSecret, config }));
      expect(denied.code).toBe('APPROVAL_REQUIRED');
      const approvalId = String(denied.details?.approvalId);
      const again = await rejection(bootstrapWorkspace(ctx, workspace.id, { actor: operator, resolveSecret, config }));
      expect(again.details?.approvalId).toBe(approvalId);
      decideApproval(ctx, approvalId, { decision: 'approved', actor: operator });

      const result = await bootstrapWorkspace(ctx, workspace.id, { actor: operator, resolveSecret, config });
      expect(result.status).toBe('succeeded');
      expect(readFileSync(join(workspace.path, 'boot.txt'), 'utf8')).toBe('token=npm_SuperSecretValue123');
      const log = readFileSync(listWorkspaceArtifacts(ctx, workspace.id)[0]!.path, 'utf8');
      expect(log).toContain('using [REDACTED]');
      expect(log).not.toContain('SuperSecretValue');
    },
  );

  test.skipIf(!posix)('bounded execution enforces timeouts, output limits and env sanitisation', async () => {
    const root = tempDir('crew-bounded-');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.CREW_TEST_LEAK = 'should-not-pass';
    const env = await runBounded(['/bin/sh', '-c', 'echo "[$CREW_TEST_LEAK]"; yes | head -c 100000'], {
      cwd: root,
      permittedRoots: [root],
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      network: 'offline',
    });
    delete process.env.CREW_TEST_LEAK;
    expect(env.stdout.startsWith('[]')).toBe(true);
    expect(env.truncated).toBe(true);
    expect(env.network.enforced).toBe(false);
    const slow = await runBounded(['/bin/sh', '-c', 'sleep 5'], {
      cwd: root,
      permittedRoots: [root],
      timeoutMs: 150,
      graceMs: 100,
      maxOutputBytes: 1024,
    });
    expect(slow).toMatchObject({ timedOut: true, exitCode: null });
    expect(slow.durationMs).toBeLessThan(3_000);
    expect(platformLimitations('linux').map((l) => l.id)).toContain('worktree-not-sandbox');
    expect(platformLimitations('win32').map((l) => l.id)).toContain('windows-tree-kill');
  });
});

describe('crew commits agent changes', () => {
  test('commits every change with hooks disabled, and does nothing on a clean worktree', async () => {
    const { ctx, newTask, config } = await setup();
    const task = newTask('Change app');
    const { workspace } = await allocateWorkspace(ctx, { taskId: task.id, actor: operator, config });
    writeFiles(workspace.path, { 'src/app.ts': 'export const v = 2;\n', 'src/new.ts': 'export {};\n' });
    const hook = join(await gitText(workspace.path, ['rev-parse', '--git-common-dir']), 'hooks', 'pre-commit');
    writeFiles(workspace.path, {});
    await Bun.write(hook, '#!/bin/sh\nexit 1\n');
    await Bun.$`chmod +x ${hook}`;

    const result = await commitWorkspaceChanges(ctx, workspace.id, { message: 'TASK-1: change app', actor: operator });
    expect(result).toMatchObject({ committed: true, files: ['src/app.ts', 'src/new.ts'] });
    expect(await gitText(workspace.path, ['status', '--porcelain'])).toBe('');
    expect((await collectCommits(ctx, workspace.id)).commits.map((c) => c.subject)).toEqual(['TASK-1: change app']);

    const again = await commitWorkspaceChanges(ctx, workspace.id, { message: 'noop', actor: operator });
    expect(again).toMatchObject({ committed: false, sha: null });
  });
});
