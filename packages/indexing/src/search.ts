import type { Database } from 'bun:sqlite';
import { CrewError, trimTrailingSlashes } from '@crewyard/core';
import { all, type CrewContext } from '@crewyard/storage';
import { readChunks, readLines } from './content.ts';
import { cosine, decodeVector, type EmbeddingProvider, modelKey } from './embeddings.ts';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import { type SnapshotModel, snapshotModel, traverse } from './graph.ts';
import type { SnapshotFileRow } from './manifests.ts';
import type { FileKind, Provenance, ResultEnvelope, SymbolInfo } from './types.ts';

export type SearchMode = 'fts' | 'exact' | 'regex' | 'path' | 'symbol' | 'hybrid';
export type MatchKind = 'fts' | 'exact' | 'regex' | 'path' | 'symbol' | 'semantic' | 'graph' | 'hint';

export interface FileFilter {
  paths?: string[];
  excludePaths?: string[];
  kinds?: FileKind[];
  languages?: string[];
}

export interface SearchInput extends SnapshotRequest, FileFilter {
  query: string;
  mode?: SearchMode;
  limit?: number;
  caseSensitive?: boolean;
  contextLines?: number;
  hints?: { paths?: string[]; symbols?: string[] };
  embeddingProvider?: EmbeddingProvider | null;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  blobSha: string;
  score: number;
  matchKind: MatchKind;
  reasons: string[];
  excerpt: string;
  symbol: SymbolInfo | null;
  provenance: Provenance;
}

export interface SearchResult extends ResultEnvelope {
  query: string;
  mode: SearchMode;
  hits: SearchHit[];
  truncated: boolean;
  notes: string[];
}

const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const SCAN_DEADLINE_MS = 5_000;
const GLOB_CHARS = /[*?[\]{}]/;

export function compileFilter(filter: FileFilter): (file: SnapshotFileRow) => boolean {
  const include = (filter.paths ?? []).map((p) => (GLOB_CHARS.test(p) ? new Bun.Glob(p) : trimTrailingSlashes(p)));
  const exclude = (filter.excludePaths ?? []).map((p) => new Bun.Glob(p));
  const kinds = filter.kinds ? new Set<string>(filter.kinds) : null;
  const languages = filter.languages ? new Set(filter.languages) : null;
  return (file) => {
    if (kinds && !kinds.has(file.kind)) return false;
    if (languages && (file.language === null || !languages.has(file.language))) return false;
    if (exclude.some((g) => g.match(file.path))) return false;
    if (include.length === 0) return true;
    return include.some((p) =>
      typeof p === 'string' ? file.path === p || file.path.startsWith(`${p}/`) : p.match(file.path),
    );
  };
}

export function queryTokens(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_$]+/gu) ?? [])].filter((t) => t.length > 1 || /\d/.test(t));
}

function ftsOr(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

interface FtsRow {
  rowid: number;
  blob_sha: string;
  start_line: number;
  end_line: number;
  content: string;
  rank: number;
  path: string;
}

function ftsHits(
  db: Database,
  snapshotId: string,
  match: string,
  want: number,
  accept: (path: string) => boolean,
): FtsRow[] {
  let candidateLimit = Math.max(200, want * 8);
  for (;;) {
    const rows = all<FtsRow>(
      db,
      `WITH hits AS (
         SELECT rowid, blob_sha, start_line, end_line, content, rank FROM fts_entries
         WHERE fts_entries MATCH ? ORDER BY rank LIMIT ?
       )
       SELECT hits.*, f.path FROM hits JOIN files f ON f.blob_sha = hits.blob_sha AND f.snapshot_id = ?
       ORDER BY hits.rank, f.path`,
      match,
      candidateLimit,
      snapshotId,
    ).filter((r) => accept(r.path));
    const exhausted = rows.length >= want || candidateLimit >= 50_000;
    if (exhausted) return rows;
    const total = all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM fts_entries WHERE fts_entries MATCH ?', match)[0]!
      .n;
    if (total <= candidateLimit) return rows;
    candidateLimit *= 8;
  }
}

function bestWindow(content: string, startLine: number, test: (line: string) => number, contextLines: number) {
  const lines = content.split('\n');
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const score = test(lines[i]!);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  const from = Math.max(0, best - contextLines);
  const to = Math.min(lines.length - 1, best + contextLines);
  return { startLine: startLine + from, endLine: startLine + to, excerpt: lines.slice(from, to + 1).join('\n') };
}

function tokenCounter(tokens: readonly string[]): (line: string) => number {
  const lowered = tokens.map((t) => t.toLowerCase());
  return (line) => {
    const l = line.toLowerCase();
    let n = 0;
    for (const t of lowered) if (l.includes(t)) n++;
    return n;
  };
}

interface Ctx {
  db: Database;
  model: SnapshotModel;
  envelope: ResultEnvelope;
  accept: (path: string) => boolean;
}

function provenance(c: Ctx, path: string, blobSha: string, startLine: number, endLine: number): Provenance {
  return {
    repositoryId: c.envelope.repositoryId,
    commitSha: c.envelope.commitSha,
    path,
    startLine,
    endLine,
    blobSha,
    retrievedAt: c.envelope.retrievedAt,
    indexStatus: c.envelope.indexStatus,
  };
}

function hit(c: Ctx, h: Omit<SearchHit, 'provenance'>): SearchHit {
  return { ...h, provenance: provenance(c, h.path, h.blobSha, h.startLine, h.endLine) };
}

function ftsSearch(c: Ctx, query: string, limit: number, contextLines: number): SearchHit[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const rows = ftsHits(c.db, c.model.snapshot.id, ftsOr(tokens), limit, c.accept);
  const counter = tokenCounter(tokens);
  return rows.slice(0, limit).map((r) => {
    const w = bestWindow(r.content, r.start_line, counter, contextLines);
    return hit(c, {
      path: r.path,
      blobSha: r.blob_sha,
      ...w,
      score: -r.rank,
      matchKind: 'fts',
      reasons: [`full-text match for ${tokens.join(', ')}`],
      symbol: null,
    });
  });
}

function lineHits(
  c: Ctx,
  rows: Iterable<{ path: string; blobSha: string; startLine: number; content: string }>,
  test: (line: string) => boolean,
  kind: MatchKind,
  reason: string,
  limit: number,
  contextLines: number,
): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const lines = row.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!test(lines[i]!)) continue;
      if (hits.length >= limit) return { hits, truncated: true };
      const line = row.startLine + i;
      const from = Math.max(1, line - contextLines);
      const excerptLines = contextLines === 0 ? [lines[i]!] : readLines(c.db, row.blobSha, from, line + contextLines);
      hits.push(
        hit(c, {
          path: row.path,
          blobSha: row.blobSha,
          startLine: from,
          endLine: from + excerptLines.length - 1,
          excerpt: excerptLines.join('\n'),
          score: 1,
          matchKind: kind,
          reasons: [reason],
          symbol: null,
        }),
      );
    }
  }
  return { hits, truncated: false };
}

function* scanRows(
  c: Ctx,
  notes: string[],
): Generator<{ path: string; blobSha: string; startLine: number; content: string }> {
  const deadline = performance.now() + SCAN_DEADLINE_MS;
  let bytes = 0;
  const textual = new Set(
    all<{ sha: string }>(
      c.db,
      `SELECT DISTINCT b.sha FROM files f JOIN blobs b ON b.sha = f.blob_sha
       WHERE f.snapshot_id = ? AND b.parse_status != 'skipped' AND b.line_count > 0`,
      c.model.snapshot.id,
    ).map((r) => r.sha),
  );
  for (const file of c.model.files) {
    if (!textual.has(file.blob_sha) || !c.accept(file.path)) continue;
    if (bytes > MAX_SCAN_BYTES || performance.now() > deadline) {
      notes.push('Scan stopped at its byte/time bound; narrow the search with path filters.');
      return;
    }
    for (const chunk of readChunks(c.db, file.blob_sha)) {
      bytes += chunk.content.length;
      yield { path: file.path, blobSha: file.blob_sha, startLine: chunk.startLine, content: chunk.content };
    }
  }
}

function exactSearch(
  c: Ctx,
  query: string,
  caseSensitive: boolean,
  limit: number,
  contextLines: number,
  notes: string[],
) {
  const needle = caseSensitive ? query : query.toLowerCase();
  const test = (line: string) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  const tokens = queryTokens(query);
  if (tokens.length === 0 || query.includes('\n')) {
    return lineHits(c, scanRows(c, notes), test, 'exact', 'exact text match (scan)', limit, contextLines);
  }
  const phrase = `"${tokens.join(' ').replaceAll('"', '""')}"`;
  const rows = ftsHits(c.db, c.model.snapshot.id, phrase, limit * 4, c.accept).map((r) => ({
    path: r.path,
    blobSha: r.blob_sha,
    startLine: r.start_line,
    content: r.content,
  }));
  return lineHits(c, rows, test, 'exact', 'exact text match', limit, contextLines);
}

function regexSearch(
  c: Ctx,
  query: string,
  caseSensitive: boolean,
  limit: number,
  contextLines: number,
  notes: string[],
) {
  let pattern: RegExp;
  try {
    pattern = new RegExp(query, caseSensitive ? 'u' : 'iu');
  } catch (error) {
    throw new CrewError('INVALID_INPUT', `Invalid regular expression: ${(error as Error).message}`);
  }
  return lineHits(
    c,
    scanRows(c, notes),
    (line) => pattern.test(line),
    'regex',
    `regex /${query}/`,
    limit,
    contextLines,
  );
}

function pathSearch(c: Ctx, query: string, limit: number): SearchHit[] {
  const glob = GLOB_CHARS.test(query) ? new Bun.Glob(query) : null;
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const file of c.model.files) {
    if (!c.accept(file.path)) continue;
    const lower = file.path.toLowerCase();
    const matched = glob ? glob.match(file.path) : lower.includes(needle);
    if (!matched) continue;
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const score = glob ? 1 : base.startsWith(needle) ? 2 : base.includes(needle) ? 1.5 : 1;
    hits.push(
      hit(c, {
        path: file.path,
        blobSha: file.blob_sha,
        startLine: 1,
        endLine: 1,
        excerpt: '',
        score,
        matchKind: 'path',
        reasons: [`path matches ${query}`],
        symbol: null,
      }),
    );
  }
  return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

export interface SymbolRow {
  name: string;
  kind: string;
  container: string | null;
  exported: number;
  signature: string | null;
  start_line: number;
  end_line: number;
  blob_sha: string;
  path: string;
}

export function toSymbolInfo(row: SymbolRow): SymbolInfo {
  return {
    name: row.name,
    kind: row.kind,
    container: row.container,
    exported: row.exported === 1,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
  };
}

export type SymbolMatch = 'exact' | 'prefix' | 'contains';

export function querySymbols(
  db: Database,
  snapshotId: string,
  name: string,
  match: SymbolMatch,
  limit: number,
  extra: { kind?: string; container?: string } = {},
): SymbolRow[] {
  const where = ['f.snapshot_id = ?'];
  const params: (string | number)[] = [snapshotId];
  if (match === 'exact') {
    where.push('s.name = ?');
    params.push(name);
  } else if (match === 'prefix') {
    where.push('s.name GLOB ?');
    params.push(`${name.replace(/[*?[\]]/g, (ch) => `[${ch}]`)}*`);
  } else {
    where.push("s.name LIKE ? ESCAPE '\\'");
    params.push(`%${name.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  }
  if (extra.kind) {
    where.push('s.kind = ?');
    params.push(extra.kind);
  }
  if (extra.container) {
    where.push('s.container = ?');
    params.push(extra.container);
  }
  params.push(limit);
  return all<SymbolRow>(
    db,
    `SELECT s.name, s.kind, s.container, s.exported, s.signature, s.start_line, s.end_line, s.blob_sha, f.path
     FROM symbols s JOIN files f ON f.blob_sha = s.blob_sha
     WHERE ${where.join(' AND ')}
     ORDER BY s.exported DESC, f.path, s.start_line LIMIT ?`,
    ...params,
  );
}

export function splitQualified(name: string): { name: string; container?: string } {
  const parts = name.split(/::|\.|#/).filter(Boolean);
  if (parts.length < 2) return { name };
  return { name: parts[parts.length - 1]!, container: parts[parts.length - 2]! };
}

const MAX_SYMBOL_EXCERPT_LINES = 80;

function symbolHits(c: Ctx, query: string, limit: number): SearchHit[] {
  const q = splitQualified(query.trim());
  const extra = q.container ? { container: q.container } : {};
  let rows = querySymbols(c.db, c.model.snapshot.id, q.name, 'exact', limit, extra);
  if (rows.length === 0) rows = querySymbols(c.db, c.model.snapshot.id, q.name, 'prefix', limit, extra);
  return rows
    .filter((r) => c.accept(r.path))
    .map((r) => {
      const end = Math.min(r.end_line, r.start_line + MAX_SYMBOL_EXCERPT_LINES - 1);
      return hit(c, {
        path: r.path,
        blobSha: r.blob_sha,
        startLine: r.start_line,
        endLine: end,
        excerpt: readLines(c.db, r.blob_sha, r.start_line, end).join('\n'),
        score: r.name === q.name ? 2 : 1,
        matchKind: 'symbol',
        reasons: [`${r.kind} ${r.container ? `${r.container}.` : ''}${r.name} is defined here`],
        symbol: toSymbolInfo(r),
      });
    });
}

interface Candidate {
  path: string;
  blobSha: string;
  startLine: number;
  endLine: number;
  symbol: SymbolInfo | null;
  scores: Partial<Record<MatchKind, number>>;
  reasons: string[];
}

const WEIGHTS: Record<MatchKind, number> = {
  hint: 1.5,
  symbol: 1.2,
  fts: 1.0,
  exact: 1.0,
  regex: 1.0,
  semantic: 1.0,
  path: 0.5,
  graph: 0.35,
};

async function hybridSearch(
  c: Ctx,
  input: SearchInput,
  limit: number,
  contextLines: number,
  notes: string[],
): Promise<SearchHit[]> {
  const candidates = new Map<string, Candidate>();
  const add = (
    h: { path: string; blobSha: string; startLine: number; endLine: number; symbol?: SymbolInfo | null },
    kind: MatchKind,
    score: number,
    reason: string,
  ) => {
    const key = `${h.path}:${h.startLine}`;
    let cand = candidates.get(key);
    if (!cand) {
      cand = {
        path: h.path,
        blobSha: h.blobSha,
        startLine: h.startLine,
        endLine: h.endLine,
        symbol: h.symbol ?? null,
        scores: {},
        reasons: [],
      };
      candidates.set(key, cand);
    }
    cand.scores[kind] = Math.max(cand.scores[kind] ?? 0, score);
    cand.endLine = Math.max(cand.endLine, h.endLine);
    if (!cand.symbol && h.symbol) cand.symbol = h.symbol;
    if (!cand.reasons.includes(reason)) cand.reasons.push(reason);
  };

  const fts = ftsSearch(c, input.query, 60, contextLines);
  const maxFts = Math.max(...fts.map((h) => h.score), 1e-9);
  for (const h of fts) add(h, 'fts', h.score / maxFts, h.reasons[0]!);

  for (const token of queryTokens(input.query)
    .filter((t) => t.length >= 3)
    .slice(0, 12)) {
    for (const h of symbolHits(c, token, 10)) add(h, 'symbol', h.symbol?.name === token ? 1 : 0.6, h.reasons[0]!);
  }
  for (const name of input.hints?.symbols ?? []) {
    for (const h of symbolHits(c, name, 10)) add(h, 'hint', 1, `requested symbol ${name}`);
  }
  for (const pattern of input.hints?.paths ?? []) {
    const accept = compileFilter({ paths: [pattern] });
    for (const file of c.model.files.filter(accept).slice(0, 25)) {
      const outline = all<SymbolRow>(
        c.db,
        `SELECT s.name, s.kind, s.container, s.exported, s.signature, s.start_line, s.end_line, s.blob_sha, ? AS path
         FROM symbols s WHERE s.blob_sha = ? AND s.container IS NULL ORDER BY s.exported DESC, s.start_line LIMIT 8`,
        file.path,
        file.blob_sha,
      );
      if (outline.length === 0)
        add(
          { path: file.path, blobSha: file.blob_sha, startLine: 1, endLine: 40 },
          'hint',
          0.8,
          `requested path ${pattern}`,
        );
      for (const s of outline) {
        add(
          { path: s.path, blobSha: s.blob_sha, startLine: s.start_line, endLine: s.end_line, symbol: toSymbolInfo(s) },
          'hint',
          0.8,
          `declared in requested path ${pattern}`,
        );
      }
    }
  }
  for (const token of queryTokens(input.query)
    .filter((t) => t.length >= 3)
    .slice(0, 6)) {
    for (const h of pathSearch(c, token, 10)) add({ ...h, endLine: 40 }, 'path', h.score / 2, h.reasons[0]!);
  }

  if (input.embeddingProvider) {
    try {
      await addSemantic(c, input.embeddingProvider, input.query, add);
    } catch (error) {
      notes.push(`Semantic scoring skipped: ${(error as Error).message}`);
    }
  }

  const scored = [...candidates.values()].map((cand) => ({
    cand,
    score: Object.entries(cand.scores).reduce((sum, [k, v]) => sum + WEIGHTS[k as MatchKind] * (v ?? 0), 0),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topFiles = [...new Set(scored.slice(0, 5).map((s) => s.cand.path))];
  const topScore = scored[0]?.score ?? 0;
  if (topFiles.length > 0) {
    const { depths } = traverse(c.model, topFiles, 'both', 1, 40);
    for (const [path, depth] of depths) {
      if (depth === 0 || !c.accept(path)) continue;
      const file = c.model.byPath.get(path)!;
      const already = scored.some((s) => s.cand.path === path);
      if (already) continue;
      const key = `${path}:1`;
      const cand: Candidate = {
        path,
        blobSha: file.blob_sha,
        startLine: 1,
        endLine: 30,
        symbol: null,
        scores: { graph: 0.5 },
        reasons: ['imports or is imported by a top-ranked file'],
      };
      candidates.set(key, cand);
      scored.push({ cand, score: WEIGHTS.graph * 0.5 * Math.min(1, topScore) });
    }
    scored.sort((a, b) => b.score - a.score);
  }

  return scored
    .filter((s) => c.accept(s.cand.path))
    .slice(0, limit)
    .map(({ cand, score }) => {
      const kinds = Object.keys(cand.scores) as MatchKind[];
      const primary =
        kinds.sort((a, b) => WEIGHTS[b] * (cand.scores[b] ?? 0) - WEIGHTS[a] * (cand.scores[a] ?? 0))[0] ?? 'fts';
      return hit(c, {
        path: cand.path,
        blobSha: cand.blobSha,
        startLine: cand.startLine,
        endLine: cand.endLine,
        excerpt: '',
        score: Number(score.toFixed(4)),
        matchKind: primary,
        reasons: cand.reasons,
        symbol: cand.symbol,
      });
    });
}

async function addSemantic(
  c: Ctx,
  provider: EmbeddingProvider,
  query: string,
  add: (
    h: { path: string; blobSha: string; startLine: number; endLine: number },
    kind: MatchKind,
    score: number,
    reason: string,
  ) => void,
): Promise<void> {
  const model = modelKey(provider);
  const rows = all<{ blob_sha: string; start_line: number; vector: Uint8Array }>(
    c.db,
    `SELECT e.blob_sha, e.start_line, e.vector FROM embeddings e
     WHERE e.model = ? AND e.blob_sha IN (SELECT blob_sha FROM files WHERE snapshot_id = ?) LIMIT 200000`,
    model,
    c.model.snapshot.id,
  );
  if (rows.length === 0) return;
  const [queryVector] = await provider.embed([query]);
  if (!queryVector) return;
  const pathsByBlob = new Map<string, string[]>();
  for (const f of c.model.files) {
    const list = pathsByBlob.get(f.blob_sha);
    if (list) list.push(f.path);
    else pathsByBlob.set(f.blob_sha, [f.path]);
  }
  const scored = rows
    .map((r) => ({ r, score: cosine(queryVector, decodeVector(r.vector)) }))
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);
  for (const { r, score } of scored) {
    for (const path of pathsByBlob.get(r.blob_sha) ?? []) {
      const chunk = readChunks(c.db, r.blob_sha, r.start_line, r.start_line)[0];
      add(
        { path, blobSha: r.blob_sha, startLine: r.start_line, endLine: chunk?.endLine ?? r.start_line },
        'semantic',
        score,
        `semantic similarity ${score.toFixed(2)} (${model})`,
      );
    }
  }
}

export async function search(ctx: CrewContext, input: SearchInput): Promise<SearchResult> {
  const { snapshot, envelope } = await requireSnapshot(ctx, input);
  const model = snapshotModel(ctx.store, snapshot);
  const filter = compileFilter(input);
  const accept = (path: string) => {
    const file = model.byPath.get(path);
    return file !== undefined && filter(file);
  };
  const c: Ctx = { db: ctx.store.db, model, envelope, accept };
  const mode = input.mode ?? 'hybrid';
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 500);
  const contextLines = Math.min(Math.max(input.contextLines ?? 3, 0), 40);
  const caseSensitive = input.caseSensitive ?? false;
  const notes: string[] = [];
  if (input.query.trim() === '' && mode !== 'hybrid')
    throw new CrewError('INVALID_INPUT', 'Search query must not be empty');
  let hits: SearchHit[];
  let truncated = false;
  switch (mode) {
    case 'fts':
      hits = ftsSearch(c, input.query, limit + 1, contextLines);
      break;
    case 'exact': {
      const r = exactSearch(c, input.query, caseSensitive, limit + 1, contextLines, notes);
      hits = r.hits;
      truncated = r.truncated;
      break;
    }
    case 'regex': {
      const r = regexSearch(c, input.query, caseSensitive, limit + 1, contextLines, notes);
      hits = r.hits;
      truncated = r.truncated;
      break;
    }
    case 'path':
      hits = pathSearch(c, input.query, limit + 1);
      break;
    case 'symbol':
      hits = symbolHits(c, input.query, limit + 1);
      break;
    case 'hybrid':
      hits = await hybridSearch(c, input, limit + 1, contextLines, notes);
      for (const h of hits) {
        if (h.excerpt !== '') continue;
        const end = Math.min(h.endLine, h.startLine + MAX_SYMBOL_EXCERPT_LINES - 1);
        h.endLine = end;
        h.provenance.endLine = end;
        h.excerpt = readLines(c.db, h.blobSha, h.startLine, end).join('\n');
        const lines = h.excerpt === '' ? 0 : h.excerpt.split('\n').length;
        if (lines > 0 && h.startLine + lines - 1 < end) {
          h.endLine = h.startLine + lines - 1;
          h.provenance.endLine = h.endLine;
        }
      }
      break;
  }
  if (hits.length > limit) {
    hits = hits.slice(0, limit);
    truncated = true;
  }
  if (!input.embeddingProvider && mode === 'hybrid')
    notes.push('No embedding model configured; ranking uses full-text, symbol, path and graph signals.');
  return { ...envelope, query: input.query, mode, hits, truncated, notes };
}
