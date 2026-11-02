import { afterEach, describe, expect, test } from 'bun:test';
import { git } from '@crewyard/core';
import { dependencyGraph, findSymbol, indexRepository, search } from '@crewyard/indexing';
import { all } from '@crewyard/storage';
import { commitFiles } from '../../helpers/index.ts';
import { createIndexFixture, type IndexFixture, POLYGLOT_FILES } from './fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

describe('incremental indexing', () => {
  test('changing one file parses exactly one new blob and copies the rest from the parent snapshot', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    const first = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const blobsBefore = all<{ n: number }>(fx.ctx.store.db, 'SELECT COUNT(*) AS n FROM blobs')[0]!.n;

    const sha = await commitFiles(fx.repoPath, {
      'src/math.ts':
        'export function add(a: number, b: number): number {\n  return b + a;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n',
    });
    const second = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha });

    expect(second.stats.mode).toBe('incremental');
    expect(second.snapshot.parentSnapshotId).toBe(first.snapshot.id);
    expect(second.snapshot.changedCount).toBe(1);
    expect(second.snapshot.parsedCount).toBe(1);
    expect(second.snapshot.fileCount).toBe(first.snapshot.fileCount);
    expect(all<{ n: number }>(fx.ctx.store.db, 'SELECT COUNT(*) AS n FROM blobs')[0]!.n).toBe(blobsBefore + 1);

    const sel = { repositoryId: fx.repositoryId };
    expect((await findSymbol(fx.ctx, { ...sel, sha, name: 'sub' })).definitions).toHaveLength(1);
    expect((await findSymbol(fx.ctx, { ...sel, sha: first.snapshot.commitSha, name: 'sub' })).definitions).toHaveLength(
      0,
    );

    const again = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha });
    expect(again.stats.mode).toBe('noop');
  });

  test('renames and deletes update the file set and the import graph', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    await git(fx.repoPath, ['mv', 'src/math.ts', 'src/arith.ts']);
    await git(fx.repoPath, ['rm', '-q', 'py/pkg/service.py']);
    const sha = await commitFiles(
      fx.repoPath,
      { 'src/app.ts': POLYGLOT_FILES['src/app.ts']!.replace('./math.js', './arith.js') },
      'rename',
    );
    const { snapshot, stats } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha });

    expect(stats.mode).toBe('incremental');
    expect(snapshot.changedCount).toBe(3);
    expect(snapshot.parsedCount).toBe(1);
    const sel = { repositoryId: fx.repositoryId, sha };
    const paths = (await search(fx.ctx, { ...sel, query: 'src/*', mode: 'path' })).hits.map((h) => h.path).sort();
    expect(paths).toEqual(['src/app.test.ts', 'src/app.ts', 'src/arith.ts']);
    expect((await search(fx.ctx, { ...sel, query: 'service', mode: 'path' })).hits).toHaveLength(0);
    expect((await findSymbol(fx.ctx, { ...sel, name: 'add' })).definitions[0]!.path).toBe('src/arith.ts');
    const graph = await dependencyGraph(fx.ctx, { ...sel, paths: ['src/arith.ts'], direction: 'importedBy' });
    expect(graph.edges.find((e) => e.from === 'src/app.ts')?.to).toBe('src/arith.ts');
  });
});
