import { afterEach, describe, expect, test } from 'bun:test';
import { buildContextPack, fetchContextPackPage } from '@crewyard/context';
import { indexRepository } from '@crewyard/indexing';
import { one } from '@crewyard/storage';
import { createIndexFixture, type IndexFixture } from '../indexing/fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

function moduleSource(i: number): string {
  const body = Array.from({ length: 30 }, (_, j) => `  const ledgerValue${j} = computeLedger(entry, ${j});`).join('\n');
  return `export function reconcileLedger${i}(entry: number): number {\n${body}\n  return entry;\n}\n`;
}

describe('context packs', () => {
  test('respect the token budget, report truncation, persist and page through remaining candidates', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) files[`src/ledger-${i}.ts`] = moduleSource(i);
    fx = await createIndexFixture(files);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });

    const pack = await buildContextPack(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: snapshot.commitSha,
      query: 'reconcile ledger computeLedger',
      budgetTokens: 400,
      maxExcerptLines: 20,
    });
    expect(pack.tokenEstimate).toBeLessThanOrEqual(400);
    expect(pack.excerpts.reduce((sum, e) => sum + e.tokenEstimate, 0)).toBe(pack.tokenEstimate);
    expect(pack.tokenEstimator).toBe('chars/4+16');
    expect(pack.excerpts.length).toBeGreaterThan(0);
    expect(pack.excerpts.every((e) => e.endLine - e.startLine + 1 <= 20 && e.reasons.length > 0)).toBe(true);
    expect(pack.warnings.some((w) => /truncated|Budget exhausted/.test(w))).toBe(true);
    expect(pack.warnings.some((w) => w.includes('exceeds 20 lines'))).toBe(true);
    expect(pack.nextCursor).not.toBeNull();
    for (const e of pack.excerpts)
      expect(e.provenance).toMatchObject({ commitSha: snapshot.commitSha, path: e.path, startLine: e.startLine });

    const stored = one<{ kind: string; token_estimate: number; commit_sha: string }>(
      fx.ctx.store.db,
      'SELECT kind, token_estimate, commit_sha FROM context_artifacts WHERE id = ?',
      pack.packId,
    );
    expect(stored).toEqual({
      kind: 'context_pack',
      token_estimate: pack.tokenEstimate,
      commit_sha: snapshot.commitSha,
    });

    const seen = new Set(pack.excerpts.map((e) => `${e.path}:${e.startLine}`));
    let cursor = pack.nextCursor;
    let pages = 1;
    while (cursor && pages < 50) {
      const page = await fetchContextPackPage(fx.ctx, { cursor });
      pages++;
      expect(page.packId).toBe(pack.packId);
      expect(page.page).toBe(pages);
      expect(page.tokenEstimate).toBeLessThanOrEqual(400);
      for (const e of page.excerpts) {
        const key = `${e.path}:${e.startLine}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set([...seen].map((k) => k.split(':')[0])).size).toBe(8);
  });

  test('defaults to the configured budget and uses scope hints', async () => {
    fx = await createIndexFixture({
      'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
      'src/b.ts': 'export function beta(): number {\n  return 2;\n}\n',
    });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const pack = await buildContextPack(fx.ctx, {
      repositoryId: fx.repositoryId,
      query: 'unrelated words',
      scope: { symbols: ['beta'] },
    });
    expect(pack.budgetTokens).toBe(8000);
    expect(pack.excerpts[0]).toMatchObject({ path: 'src/b.ts', startLine: 1, endLine: 3 });
    expect(pack.excerpts[0]!.symbol?.name).toBe('beta');
    expect(pack.excerpts[0]!.reasons).toContain('requested symbol beta');
    expect(pack.nextCursor).toBeNull();
  });
});
