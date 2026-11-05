import { expect, test } from 'bun:test';
import { buildContextPack } from '@crewyard/context';
import {
  collectGarbage,
  DEFAULT_INDEX_CONFIG,
  type EmbeddingProvider,
  embedSnapshot,
  indexRepository,
  search,
} from '@crewyard/indexing';
import { registerProject } from '@crewyard/projects';
import { commitFiles, createTempGitRepo } from '../../helpers/index.ts';
import { createIndexFixture } from './fixture.ts';

const provider: EmbeddingProvider = {
  id: 'local',
  model: 'reader-barrier',
  local: true,
  async embed(texts) {
    return texts.map(() => new Float32Array([1, 0]));
  },
};
function embeddingBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked: EmbeddingProvider = {
    ...provider,
    async embed(texts) {
      enter();
      await wait;
      return provider.embed(texts);
    },
  };
  return { ready, release, provider: blocked };
}

for (const kind of ['search', 'pack'] as const) {
  test(`active ${kind} retains exact snapshot content and artifacts across garbage collection`, async () => {
    const f = await createIndexFixture({ 'a.ts': 'export const alpha = 1;\n' });
    const barrier = embeddingBarrier();
    try {
      const first = await indexRepository(f.ctx, { repositoryId: f.repositoryId });
      await embedSnapshot(f.ctx, { repositoryId: f.repositoryId, sha: first.snapshot.commitSha, provider });
      const next = await commitFiles(f.repoPath, { 'a.ts': 'export const beta = 2;\n' });
      await indexRepository(f.ctx, { repositoryId: f.repositoryId, sha: next });
      const input = {
        repositoryId: f.repositoryId,
        sha: first.snapshot.commitSha,
        query: 'alpha',
        embeddingProvider: barrier.provider,
      };
      const pending = kind === 'search' ? search(f.ctx, { ...input, mode: 'hybrid' }) : buildContextPack(f.ctx, input);
      await barrier.ready;
      expect(collectGarbage(f.ctx, { repositoryId: f.repositoryId, retainLatest: 1, dryRun: false }).snapshots).toEqual(
        [],
      );
      barrier.release();
      const result = await pending;
      expect(result.snapshotId).toBe(first.snapshot.id);
      expect('hits' in result ? result.hits[0]!.excerpt : result.excerpts[0]!.text).toContain(
        'export const alpha = 1;',
      );
      if ('packId' in result)
        expect(f.ctx.store.db.query('SELECT 1 FROM context_artifacts WHERE id = ?').get(result.packId)).not.toBeNull();
      expect(
        collectGarbage(f.ctx, { repositoryId: f.repositoryId, retainLatest: 1, dryRun: false }).snapshots.map(
          (snapshot) => snapshot.id,
        ),
      ).toContain(first.snapshot.id);
    } finally {
      barrier.release();
      f.cleanup();
    }
  });
}

for (const target of ['next-commit', 'other-repository'] as const) {
  test(`shared extraction replacement protects readers and invalidates historical snapshots across ${target}`, async () => {
    const source = `export const alpha = 1;\n${'// filler\n'.repeat(200)}`;
    const f = await createIndexFixture({ 'a.ts': source, 'b.ts': 'export const beta = 1;\n' });
    const barrier = embeddingBarrier();
    try {
      const first = await indexRepository(f.ctx, { repositoryId: f.repositoryId });
      await embedSnapshot(f.ctx, { repositoryId: f.repositoryId, sha: first.snapshot.commitSha, provider });
      let repositoryId = f.repositoryId;
      let sha: string | undefined;
      if (target === 'next-commit') sha = await commitFiles(f.repoPath, { 'b.ts': 'export const beta = 2;\n' });
      else {
        const repoPath = await createTempGitRepo({ 'a.ts': source, 'b.ts': 'export const beta = 2;\n' });
        repositoryId = (
          await registerProject(f.ctx, { repoPath, baseBranch: 'main', actor: { kind: 'operator', id: 'test' } })
        ).repository.id;
      }
      const second = await indexRepository(f.ctx, { repositoryId, ...(sha ? { sha } : {}) });
      const pending = search(f.ctx, {
        repositoryId: f.repositoryId,
        sha: first.snapshot.commitSha,
        query: 'alpha',
        mode: 'hybrid',
        embeddingProvider: barrier.provider,
      });
      await barrier.ready;
      const rebuild = {
        repositoryId,
        sha: second.snapshot.commitSha,
        force: true,
        config: { ...DEFAULT_INDEX_CONFIG, max_file_bytes: 1024 },
      };
      await expect(indexRepository(f.ctx, rebuild)).rejects.toMatchObject({ code: 'BUSY' });
      barrier.release();
      expect((await pending).hits[0]!.excerpt).toContain('export const alpha = 1;');
      await indexRepository(f.ctx, rebuild);
      await expect(
        search(f.ctx, {
          repositoryId: f.repositoryId,
          sha: first.snapshot.commitSha,
          query: 'alpha',
          config: DEFAULT_INDEX_CONFIG,
        }),
      ).rejects.toMatchObject({ code: 'INDEX_STALE' });
    } finally {
      barrier.release();
      f.cleanup();
    }
  });
}
