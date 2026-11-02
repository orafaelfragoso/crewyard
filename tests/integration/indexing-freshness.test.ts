import { afterEach, describe, expect, test } from 'bun:test';
import { buildContextPack } from '@agent-rail/context';
import { git, isRailError, type RailError } from '@agent-rail/core';
import { indexRepository, indexStatus, search } from '@agent-rail/indexing';
import { commitFiles } from '../helpers/index.ts';
import { createIndexFixture, type IndexFixture } from '../unit/indexing/fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

async function expectRailError(promise: Promise<unknown>): Promise<RailError> {
  try {
    await promise;
  } catch (error) {
    if (isRailError(error)) return error;
    throw error;
  }
  throw new Error('expected a RailError');
}

describe('AT-19 branch-specific context', () => {
  test('every snippet comes from the requested SHA; unindexed SHAs fail with INDEX_STALE', async () => {
    fx = await createIndexFixture({ 'src/feature.ts': 'export const flag = "main-version";\n' });
    const main = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });

    await git(fx.repoPath, ['checkout', '-q', '-b', 'feature/x']);
    const branchSha = await commitFiles(fx.repoPath, { 'src/feature.ts': 'export const flag = "branch-version";\n' });
    await git(fx.repoPath, ['checkout', '-q', 'main']);

    const stale = await expectRailError(
      search(fx.ctx, { repositoryId: fx.repositoryId, sha: branchSha, query: 'flag', mode: 'fts' }),
    );
    expect(stale.code).toBe('INDEX_STALE');
    expect(stale.suggestion).toBe(`rail index update --repo ${fx.repositoryId} --ref ${branchSha}`);
    expect((await indexStatus(fx.ctx, { repositoryId: fx.repositoryId, ref: 'feature/x' })).status).toBe('stale');

    const branch = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, ref: 'feature/x' });
    expect(branch.snapshot.commitSha).toBe(branchSha);
    expect(branch.snapshot.ref).toBe('feature/x');

    const atBranch = await buildContextPack(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: branchSha,
      query: 'flag version',
    });
    expect(atBranch.commitSha).toBe(branchSha);
    expect(atBranch.excerpts.length).toBeGreaterThan(0);
    for (const excerpt of atBranch.excerpts) {
      expect(excerpt.provenance.commitSha).toBe(branchSha);
      expect(excerpt.text).not.toContain('main-version');
    }
    expect(atBranch.excerpts.map((e) => e.text).join('\n')).toContain('branch-version');

    const atMain = await search(fx.ctx, { repositoryId: fx.repositoryId, query: 'version', mode: 'exact' });
    expect(atMain.commitSha).toBe(main.snapshot.commitSha);
    expect(atMain.hits.map((h) => h.excerpt).join('\n')).toContain('main-version');
    expect(atMain.hits.map((h) => h.excerpt).join('\n')).not.toContain('branch-version');
    expect((await indexStatus(fx.ctx, { repositoryId: fx.repositoryId })).status).toBe('fresh');
  });

  test('on-demand indexing builds the missing snapshot instead of substituting another commit', async () => {
    fx = await createIndexFixture({ 'a.py': 'def alpha():\n    return 1\n' });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const next = await commitFiles(fx.repoPath, { 'a.py': 'def beta():\n    return 2\n' });
    const result = await search(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: next,
      query: 'beta',
      mode: 'symbol',
      onDemand: true,
    });
    expect(result.commitSha).toBe(next);
    expect(result.hits.map((h) => h.symbol?.name)).toEqual(['beta']);
  });
});
