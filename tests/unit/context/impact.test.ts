import { afterEach, describe, expect, test } from 'bun:test';
import { analyzeImpact, IMPACT_DISCLAIMER, interfaceFingerprint } from '@crewyard/context';
import { indexRepository } from '@crewyard/indexing';
import { commitFiles } from '../../helpers/index.ts';
import { createIndexFixture, type IndexFixture } from '../indexing/fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

const FILES: Record<string, string> = {
  'packages/core/package.json': JSON.stringify({ name: '@demo/core', exports: { '.': './src/index.ts' } }),
  'packages/core/src/index.ts': "export * from './schema.ts';\n",
  'packages/core/src/schema.ts':
    'export interface Order {\n  id: string;\n}\nexport function parseOrder(raw: string): Order {\n  return { id: raw };\n}\n',
  'packages/api/package.json': JSON.stringify({ name: '@demo/api' }),
  'packages/api/src/handler.ts':
    "import { parseOrder } from '@demo/core';\n\nexport const handle = (raw: string) => parseOrder(raw);\n",
  'packages/api/src/server.ts': "import { handle } from './handler.ts';\n\nexport const serve = () => handle('1');\n",
  'packages/core/tests/schema.test.ts': "import { parseOrder } from '../src/schema.ts';\n\nparseOrder('x');\n",
  'packages/api/src/handler.spec.ts': "test('noop', () => {});\n",
};

function insertTaskWithScope(fx: IndexFixture, taskId: string, scope: string): void {
  const db = fx.ctx.store.db;
  const at = '2026-11-02T12:00:00Z';
  db.query(
    "INSERT INTO tasks (id, project_id, title, state, created_at, updated_at, state_changed_at) VALUES (?, ?, 't', 'IN_PROGRESS', ?, ?, ?)",
  ).run(taskId, fx.projectId, at, at, at);
  db.query(
    "INSERT INTO task_scope_reservations (id, task_id, repository_id, project_id, lease_generation, scope, mode, source, created_at) VALUES (?, ?, ?, ?, 1, ?, 'advisory', 'explicit', ?)",
  ).run(`res_${taskId}`, taskId, fx.repositoryId, fx.projectId, scope, at);
}

function insertOpenPr(fx: IndexFixture, number: number, changed: unknown[]): void {
  const at = '2026-11-02T12:00:00Z';
  fx.ctx.store.db
    .query(
      "INSERT INTO pull_requests (id, repository_id, number, title, head_ref, head_sha, base_ref, state, changed_files, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'abc', 'main', 'open', ?, ?, ?)",
    )
    .run(`pr_${number}`, fx.repositoryId, number, `PR ${number}`, `feature/${number}`, JSON.stringify(changed), at, at);
}

describe('impact analysis', () => {
  test('finds dependents, related tests, leased scopes and open PR overlap with confidence tiers', async () => {
    fx = await createIndexFixture(FILES);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    insertTaskWithScope(fx, 'task_core', 'packages/core/src/**');
    insertTaskWithScope(fx, 'task_api', 'packages/api');
    insertTaskWithScope(fx, 'task_docs', 'docs/**');
    insertOpenPr(fx, 1, ['packages/core/src/schema.ts']);
    insertOpenPr(fx, 2, [{ filename: 'packages/api/src/server.ts' }]);
    insertOpenPr(fx, 3, ['packages/core/package.json']);
    insertOpenPr(fx, 4, ['README.md']);

    const report = await analyzeImpact(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: snapshot.commitSha,
      paths: ['packages/core/src/schema.ts'],
      depth: 3,
    });

    expect(report.changedFiles).toEqual([
      { path: 'packages/core/src/schema.ts', packageRoot: 'packages/core', tier: 'exact', reason: 'listed as changed' },
    ]);
    expect(report.modules).toContainEqual(
      expect.objectContaining({ module: 'packages/core', kind: 'package', name: '@demo/core', tier: 'exact' }),
    );
    const deps = Object.fromEntries(report.dependents.map((d) => [d.path, `${d.tier}:${d.depth}`]));
    expect(deps).toEqual({
      'packages/core/src/index.ts': 'structural:1',
      'packages/core/tests/schema.test.ts': 'structural:1',
      'packages/api/src/handler.ts': 'structural:2',
      'packages/api/src/server.ts': 'structural:3',
    });
    expect(report.relatedTests).toEqual([
      expect.objectContaining({ path: 'packages/core/tests/schema.test.ts', tier: 'structural' }),
    ]);

    const scopes = Object.fromEntries(report.leasedScopes.map((s) => [s.taskId, s.tier]));
    expect(scopes).toEqual({ task_core: 'exact', task_api: 'structural' });

    const prs = Object.fromEntries(report.openPullRequests.map((p) => [p.number, p.tier]));
    expect(prs).toEqual({ 1: 'exact', 2: 'structural', 3: 'heuristic' });
    expect(report.disclaimer).toBe(IMPACT_DISCLAIMER);
    expect(report.reportId).toMatch(/^ctx_/);
  });

  test('symbol input maps to defining files and naming-convention tests are heuristic', async () => {
    fx = await createIndexFixture(FILES);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const report = await analyzeImpact(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: snapshot.commitSha,
      symbols: ['handle'],
      persist: false,
    });
    expect(report.changedFiles.map((c) => `${c.path}:${c.reason}`)).toEqual([
      'packages/api/src/handler.ts:defines handle',
    ]);
    expect(report.relatedTests).toContainEqual(
      expect.objectContaining({ path: 'packages/api/src/handler.spec.ts', tier: 'heuristic' }),
    );
    expect(report.dependents.find((d) => d.path === 'packages/api/src/server.ts')?.tier).toBe('structural');
    expect(report.reportId).toBeNull();
  });

  test('interface fingerprint changes with exported signatures, not with implementation bodies', async () => {
    fx = await createIndexFixture(FILES);
    const paths = ['packages/core/src/schema.ts'];
    const base = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const fp0 = await interfaceFingerprint(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: base.snapshot.commitSha,
      paths,
    });

    const bodyOnly = await commitFiles(fx.repoPath, {
      'packages/core/src/schema.ts': FILES['packages/core/src/schema.ts']!.replace('{ id: raw }', '{ id: raw.trim() }'),
    });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha: bodyOnly });
    const fp1 = await interfaceFingerprint(fx.ctx, { repositoryId: fx.repositoryId, sha: bodyOnly, paths });
    expect(fp1.fingerprint).toBe(fp0.fingerprint);

    const changed = await commitFiles(fx.repoPath, {
      'packages/core/src/schema.ts': FILES['packages/core/src/schema.ts']!.replace(
        'id: string;',
        'id: string;\n  total: number;',
      ),
    });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha: changed });
    const fp2 = await interfaceFingerprint(fx.ctx, { repositoryId: fx.repositoryId, sha: changed, paths });
    expect(fp2.fingerprint).not.toBe(fp0.fingerprint);
    expect(fp2.files[0]).toMatchObject({ basis: 'exported-symbols', exportedSymbols: 2 });
  });
});
