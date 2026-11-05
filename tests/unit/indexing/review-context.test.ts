import { afterEach, expect, test } from 'bun:test';
import { crewConfigSchema } from '@crewyard/config';
import { dependencyGraph, indexRepository } from '@crewyard/indexing';
import { commitFiles } from '../../helpers/index.ts';
import { createIndexFixture, type IndexFixture } from './fixture.ts';

let fixture: IndexFixture | undefined;
afterEach(() => fixture?.cleanup());

test('dependency context fingerprints bodies and exposes depth, node, missing and unresolved coverage', async () => {
  fixture = await createIndexFixture({
    'a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
    'b.ts': "import { c } from './c.ts';\nimport 'external';\nexport const b = c + 1;\n",
    'c.ts': 'export const c = 1;\n',
  });
  const first = await indexRepository(fixture.ctx, { repositoryId: fixture.repositoryId });
  const input = {
    repositoryId: fixture.repositoryId,
    sha: first.snapshot.commitSha,
    paths: ['a.ts', 'absent.ts'],
    direction: 'imports' as const,
    depth: 1,
    limit: 500,
  };
  const graph = await dependencyGraph(fixture.ctx, input);
  expect(graph.truncated).toBe(true);
  expect(graph.coverage).toMatchObject({ depth: 1, limit: 500, missingPaths: ['absent.ts'] });
  const deep = await dependencyGraph(fixture.ctx, { ...input, depth: 2 });
  expect(deep.coverage.unresolvedImports).toContain('b.ts:external');
  expect((await dependencyGraph(fixture.ctx, { ...input, paths: ['a.ts', 'b.ts'], limit: 1 })).truncated).toBe(true);
  const changed = await commitFiles(fixture.repoPath, {
    'b.ts': "import { c } from './c.ts';\nimport 'external';\nexport const b = c + 2;\n",
  });
  const next = await dependencyGraph(fixture.ctx, { ...input, sha: changed, onDemand: true });
  expect(next.contentFingerprint).not.toBe(graph.contentFingerprint);
  const config = crewConfigSchema.parse({ version: 1, project: { name: 'test' } }).index;
  const revised = await dependencyGraph(fixture.ctx, {
    ...input,
    config: { ...config, max_file_bytes: 1 },
    onDemand: true,
  });
  expect(revised.revision).not.toBe(graph.revision);
  expect(revised.contentFingerprint).not.toBe(graph.contentFingerprint);
  expect(revised.coverage.incompletePaths).toContain('a.ts');
});
