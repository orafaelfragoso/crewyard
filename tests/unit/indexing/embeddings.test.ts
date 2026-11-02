import { afterEach, describe, expect, test } from 'bun:test';
import { RailError } from '@agent-rail/core';
import {
  createEmbeddingProvider,
  DEFAULT_INDEX_CONFIG,
  type EmbeddingProvider,
  embedSnapshot,
  indexRepository,
  OllamaEmbeddingProvider,
  search,
} from '@agent-rail/indexing';
import { createIndexFixture, type IndexFixture } from './fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

const keywordProvider: EmbeddingProvider = {
  id: 'fake',
  model: 'keywords',
  local: true,
  async embed(texts) {
    return texts.map((t) =>
      Float32Array.from(['invoice', 'billing', 'parser'].map((k) => (t.toLowerCase().includes(k) ? 1 : 0.01))),
    );
  },
};

describe('embeddings', () => {
  test('providers are only created when configured, and remote endpoints require consent', () => {
    expect(createEmbeddingProvider(DEFAULT_INDEX_CONFIG)).toBeNull();
    const local = createEmbeddingProvider({
      ...DEFAULT_INDEX_CONFIG,
      embedding: { provider: 'ollama', model: 'nomic-embed-text', consent_external: false },
    });
    expect(local).toMatchObject({ id: 'ollama', model: 'nomic-embed-text', local: true });
    expect(() => new OllamaEmbeddingProvider({ model: 'm', endpoint: 'https://embed.example.com' })).toThrow(RailError);
  });

  test('ollama provider posts to /api/embed and validates the payload', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({
        model: 'm',
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      });
    }) as typeof fetch;
    const provider = new OllamaEmbeddingProvider({ model: 'm', fetch: fakeFetch });
    const vectors = await provider.embed(['a', 'b']);
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:11434/api/embed',
      body: { model: 'm', input: ['a', 'b'], truncate: true },
    });
    expect(vectors.map((v) => Array.from(v).map((n) => Math.round(n * 10)))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test('stored vectors add semantic candidates to hybrid ranking', async () => {
    fx = await createIndexFixture({
      'src/money.ts': 'export function totals() {\n  // invoice billing totals\n  return 1;\n}\n',
      'src/text.ts': 'export function lexer() {\n  return 2;\n}\n',
    });
    await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const embedded = await embedSnapshot(fx.ctx, { repositoryId: fx.repositoryId, provider: keywordProvider });
    expect(embedded.embedded).toBe(2);
    expect((await embedSnapshot(fx.ctx, { repositoryId: fx.repositoryId, provider: keywordProvider })).embedded).toBe(
      0,
    );

    const result = await search(fx.ctx, {
      repositoryId: fx.repositoryId,
      query: 'invoice',
      mode: 'hybrid',
      embeddingProvider: keywordProvider,
    });
    const top = result.hits[0]!;
    expect(top.path).toBe('src/money.ts');
    expect(top.reasons.some((r) => r.startsWith('semantic similarity'))).toBe(true);
  });
});
