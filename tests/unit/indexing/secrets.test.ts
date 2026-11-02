import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_INDEX_CONFIG, indexRepository, search } from '@crewyard/indexing';
import { all } from '@crewyard/storage';
import { createIndexFixture, type IndexFixture } from './fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const ENV_SECRET = 'super-secret-database-password-42';

describe('secret handling', () => {
  test('secret files are skipped, inline secrets are redacted and never persisted', async () => {
    fx = await createIndexFixture({
      '.env': `DATABASE_PASSWORD=${ENV_SECRET}\n`,
      'deploy/id_rsa': 'not really a key\n',
      'src/client.ts': `export const client = connect();\nconst token = "${TOKEN}";\nexport function connect() {\n  return token;\n}\n`,
      'vendor/lib.js': 'module.exports = 1;\n',
      'big.bin': 'abc\u0000def\n',
    });
    const { snapshot, stats } = await indexRepository(fx.ctx, {
      repositoryId: fx.repositoryId,
      config: { ...DEFAULT_INDEX_CONFIG, exclude: ['vendor/**'] },
    });
    expect(stats.secretFiles).toBe(2);
    expect(stats.excludedFiles).toBe(1);
    const paths = all<{ path: string }>(
      fx.ctx.store.db,
      'SELECT path FROM files WHERE snapshot_id = ? ORDER BY path',
      snapshot.id,
    ).map((r) => r.path);
    expect(paths).toEqual(['big.bin', 'src/client.ts']);

    const blob = all<{ parse_status: string; redactions: number }>(
      fx.ctx.store.db,
      "SELECT b.parse_status, b.redactions FROM blobs b JOIN files f ON f.blob_sha = b.sha WHERE f.path = 'src/client.ts'",
    )[0]!;
    expect(blob).toEqual({ parse_status: 'redacted', redactions: 1 });
    expect(
      all<{ s: string }>(
        fx.ctx.store.db,
        "SELECT parse_status AS s FROM blobs b JOIN files f ON f.blob_sha = b.sha WHERE f.path = 'big.bin'",
      )[0]!.s,
    ).toBe('skipped');

    const hit = (
      await search(fx.ctx, { repositoryId: fx.repositoryId, query: 'token', mode: 'exact', contextLines: 0 })
    ).hits;
    expect(hit.map((h) => h.excerpt)).toContain('const token = "[REDACTED]";');

    fx.ctx.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const file of [fx.ctx.store.path, `${fx.ctx.store.path}-wal`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file).toString('latin1');
      expect(bytes.includes(TOKEN)).toBe(false);
      expect(bytes.includes(ENV_SECRET)).toBe(false);
    }
  });
});
