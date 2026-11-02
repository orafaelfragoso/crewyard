import { newId, nowIso, RailError } from '@agent-rail/core';
import { all, type RailContext } from '@agent-rail/storage';
import { readChunks } from './content.ts';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import type { IndexConfig } from './types.ts';

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly local: boolean;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface OllamaOptions {
  model: string;
  endpoint?: string;
  consentExternal?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'ollama';
  readonly model: string;
  readonly local: boolean;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions) {
    this.model = options.model;
    this.endpoint = (options.endpoint ?? DEFAULT_OLLAMA_ENDPOINT).replace(/\/+$/, '');
    this.local = LOCAL_HOSTS.has(new URL(this.endpoint).hostname);
    if (!this.local && !options.consentExternal) {
      throw new RailError(
        'POLICY_DENIED',
        `Embedding endpoint ${this.endpoint} is not local and consent was not given`,
        {
          suggestion: 'Set index.embedding.consent_external: true to allow sending repository text to it.',
        },
      );
    }
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts, truncate: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RailError('UNAVAILABLE', `Ollama is not reachable at ${this.endpoint}`, {
        cause: error,
        suggestion: 'Start Ollama (`ollama serve`) or set index.embedding.provider: none.',
      });
    }
    if (!response.ok) {
      throw new RailError('EXTERNAL_FAILURE', `Ollama embed failed with HTTP ${response.status}`, {
        details: { body: (await response.text()).slice(0, 300) },
        retryable: response.status >= 500,
      });
    }
    const body = (await response.json()) as { embeddings?: unknown };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new RailError('EXTERNAL_FAILURE', 'Ollama returned an unexpected embedding payload', { retryable: false });
    }
    return body.embeddings.map((vector) => {
      if (!Array.isArray(vector) || vector.some((n) => typeof n !== 'number')) {
        throw new RailError('EXTERNAL_FAILURE', 'Ollama returned a non-numeric embedding', { retryable: false });
      }
      return Float32Array.from(vector as number[]);
    });
  }
}

export function createEmbeddingProvider(config: IndexConfig): EmbeddingProvider | null {
  if (config.semantic_embeddings === 'off' || config.embedding.provider === 'none' || !config.embedding.model)
    return null;
  const options: OllamaOptions = { model: config.embedding.model, consentExternal: config.embedding.consent_external };
  if (config.embedding.endpoint) options.endpoint = config.embedding.endpoint;
  return new OllamaEmbeddingProvider(options);
}

export function modelKey(provider: Pick<EmbeddingProvider, 'id' | 'model'>): string {
  return `${provider.id}:${provider.model}`;
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  return new Float32Array(Uint8Array.from(bytes).buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface EmbedSnapshotInput extends SnapshotRequest {
  provider: EmbeddingProvider;
  batchSize?: number;
  maxChunks?: number;
}

export interface EmbedSnapshotResult {
  snapshotId: string;
  commitSha: string;
  model: string;
  embedded: number;
  alreadyPresent: number;
  remaining: number;
  artifactId: string;
}

export async function embedSnapshot(ctx: RailContext, input: EmbedSnapshotInput): Promise<EmbedSnapshotResult> {
  const { snapshot } = await requireSnapshot(ctx, input);
  const model = modelKey(input.provider);
  const blobs = all<{ blob_sha: string }>(
    ctx.store.db,
    `SELECT DISTINCT f.blob_sha FROM files f JOIN blobs b ON b.sha = f.blob_sha
     WHERE f.snapshot_id = ? AND b.parse_status != 'skipped' AND b.line_count > 0`,
    snapshot.id,
  );
  const present = new Set(
    all<{ key: string }>(
      ctx.store.db,
      `SELECT e.blob_sha || ':' || e.start_line AS key FROM embeddings e
       WHERE e.model = ? AND e.blob_sha IN (SELECT blob_sha FROM files WHERE snapshot_id = ?)`,
      model,
      snapshot.id,
    ).map((r) => r.key),
  );
  const pending: { blobSha: string; startLine: number; content: string }[] = [];
  for (const { blob_sha } of blobs) {
    for (const chunk of readChunks(ctx.store.db, blob_sha)) {
      if (!present.has(`${blob_sha}:${chunk.startLine}`))
        pending.push({ blobSha: blob_sha, startLine: chunk.startLine, content: chunk.content });
    }
  }
  const max = input.maxChunks ?? Number.POSITIVE_INFINITY;
  const work = pending.slice(0, max);
  const batchSize = input.batchSize ?? 32;
  let embedded = 0;
  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    const vectors = await input.provider.embed(batch.map((b) => b.content));
    ctx.store.immediate((db) => {
      const insert = db.query(
        'INSERT OR REPLACE INTO embeddings (blob_sha, start_line, model, dimensions, vector) VALUES (?, ?, ?, ?, ?)',
      );
      batch.forEach((b, j) => {
        const vector = vectors[j]!;
        insert.run(b.blobSha, b.startLine, model, vector.length, encodeVector(vector));
      });
    });
    embedded += batch.length;
  }
  const artifactId = newId('ctx');
  const at = nowIso(ctx.clock);
  const result = {
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    model,
    embedded,
    alreadyPresent: present.size,
    remaining: pending.length - work.length,
    artifactId,
  };
  ctx.store.immediate((db) =>
    db
      .query(
        `INSERT INTO context_artifacts (id, kind, repository_id, snapshot_id, commit_sha, query, payload, token_estimate, created_at)
         VALUES (?, 'embedding_index', ?, ?, ?, NULL, ?, 0, ?)`,
      )
      .run(artifactId, snapshot.repositoryId, snapshot.id, snapshot.commitSha, JSON.stringify(result), at),
  );
  return result;
}
