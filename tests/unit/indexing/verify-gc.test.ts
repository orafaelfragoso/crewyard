import { afterEach, describe, expect, test } from 'bun:test';
import { isRailError } from '@agent-rail/core';
import { collectGarbage, indexRepository, search, verifyIndex } from '@agent-rail/indexing';
import { all } from '@agent-rail/storage';
import { commitFiles } from '../../helpers/index.ts';
import { createIndexFixture, type IndexFixture, POLYGLOT_FILES } from './fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

describe('verify and garbage collection', () => {
  test('verify passes on a clean index and detects tampered content and file rows', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const sel = { repositoryId: fx.repositoryId, sha: snapshot.commitSha };
    expect((await verifyIndex(fx.ctx, sel)).ok).toBe(true);

    const db = fx.ctx.store.db;
    const blob = all<{ blob_sha: string }>(
      db,
      "SELECT blob_sha FROM files WHERE snapshot_id = ? AND path = 'src/math.ts'",
      snapshot.id,
    )[0]!.blob_sha;
    db.query("UPDATE fts_entries SET content = content || '\n// injected' WHERE blob_sha = ?").run(blob);
    db.query("DELETE FROM files WHERE snapshot_id = ? AND path = 'README.md'").run(snapshot.id);

    const result = await verifyIndex(fx.ctx, { ...sel, markStale: true });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => `${p.kind}:${p.path}`).sort()).toEqual([
      'content_mismatch:src/math.ts',
      'missing_file:README.md',
    ]);
    expect(result.markedStale).toBe(true);
    const error = await search(fx.ctx, { ...sel, query: 'add', mode: 'fts' }).catch((e: unknown) => e);
    expect(isRailError(error) && error.code === 'INDEX_STALE' && error.suggestion?.endsWith('--force')).toBe(true);

    const rebuilt = await indexRepository(fx.ctx, { ...sel, force: true });
    expect(rebuilt.snapshot.status).toBe('available');
    expect((await verifyIndex(fx.ctx, sel)).ok).toBe(true);
  });

  test('garbage collection previews, then removes unretained snapshots and orphaned blobs', async () => {
    fx = await createIndexFixture({ 'a.ts': 'export const a = 1;\n' });
    const first = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const sha = await commitFiles(fx.repoPath, { 'a.ts': 'export const a = 2;\n' });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId, sha });

    const preview = collectGarbage(fx.ctx, { repositoryId: fx.repositoryId, retainLatest: 1 });
    expect(preview.dryRun).toBe(true);
    expect(preview.snapshots.map((s) => s.id)).toEqual([first.snapshot.id]);
    expect(preview.blobCount).toBe(1);
    expect(all<{ n: number }>(fx.ctx.store.db, 'SELECT COUNT(*) AS n FROM repository_snapshots')[0]!.n).toBe(2);

    const applied = collectGarbage(fx.ctx, { repositoryId: fx.repositoryId, retainLatest: 1, dryRun: false });
    expect(applied.blobCount).toBe(1);
    const db = fx.ctx.store.db;
    expect(all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM repository_snapshots')[0]!.n).toBe(1);
    expect(all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM blobs')[0]!.n).toBe(1);
    expect(all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM fts_entries WHERE content LIKE '%a = 1%'")[0]!.n).toBe(0);
    expect(
      (await search(fx.ctx, { repositoryId: fx.repositoryId, sha, query: 'a', mode: 'symbol' })).hits,
    ).toHaveLength(1);
  });
});
