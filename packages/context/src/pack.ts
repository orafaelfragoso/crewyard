import type { Database } from 'bun:sqlite';
import { addSeconds, newId, nowIso, RailError } from '@agent-rail/core';
import {
  DEFAULT_INDEX_CONFIG,
  type EmbeddingProvider,
  type FileFilter,
  type IndexConfig,
  indexCommand,
  type Provenance,
  type ResultEnvelope,
  readLines,
  requireSnapshot,
  type SnapshotRequest,
  type SymbolInfo,
  search,
  snapshotByCommit,
} from '@agent-rail/indexing';
import { one, parseJson, type RailContext } from '@agent-rail/storage';
import { estimateExcerptTokens, linesWithinBudget, TOKEN_ESTIMATOR } from './tokens.ts';

export interface ContextPackInput extends SnapshotRequest {
  query: string;
  scope?: { paths?: string[]; symbols?: string[] };
  filter?: FileFilter;
  budgetTokens?: number;
  maxExcerptLines?: number;
  maxCandidates?: number;
  embeddingProvider?: EmbeddingProvider | null;
  ttlHours?: number;
  config?: IndexConfig;
}

export interface ContextExcerpt {
  rank: number;
  path: string;
  startLine: number;
  endLine: number;
  blobSha: string;
  score: number;
  symbol: SymbolInfo | null;
  reasons: string[];
  tokenEstimate: number;
  truncated: boolean;
  text: string;
  provenance: Provenance;
}

export interface ContextPack extends ResultEnvelope {
  packId: string;
  query: string;
  page: number;
  budgetTokens: number;
  tokenEstimate: number;
  tokenEstimator: string;
  excerpts: ContextExcerpt[];
  totalCandidates: number;
  warnings: string[];
  notes: string[];
  nextCursor: string | null;
}

interface StoredCandidate {
  path: string;
  blobSha: string;
  startLine: number;
  endLine: number;
  score: number;
  reasons: string[];
  symbol: SymbolInfo | null;
}

interface PackPayload {
  version: 1;
  query: string;
  repositoryId: string;
  snapshotId: string;
  commitSha: string;
  budgetTokens: number;
  scope: { paths?: string[]; symbols?: string[] } | null;
  candidates: StoredCandidate[];
  notes: string[];
}

interface CursorState {
  p: string;
  i: number;
  l: number;
  n: number;
}

const MERGE_GAP_LINES = 3;

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeCursor(cursor: string): CursorState {
  const state = parseJson<Partial<CursorState>>(Buffer.from(cursor, 'base64url').toString('utf8'), {});
  if (
    typeof state.p !== 'string' ||
    typeof state.i !== 'number' ||
    typeof state.l !== 'number' ||
    typeof state.n !== 'number'
  ) {
    throw new RailError('INVALID_INPUT', 'Malformed context pack cursor');
  }
  return state as CursorState;
}

function mergeCandidates(hits: readonly StoredCandidate[], maxLines: number, warnings: string[]): StoredCandidate[] {
  const merged: StoredCandidate[] = [];
  for (const hit of hits) {
    let range = { ...hit, reasons: [...hit.reasons] };
    if (range.endLine - range.startLine + 1 > maxLines) {
      warnings.push(
        `${range.path}:${range.startLine}-${range.endLine} exceeds ${maxLines} lines; excerpt limited (page further or read the range explicitly).`,
      );
      range = { ...range, endLine: range.startLine + maxLines - 1 };
    }
    const target = merged.find(
      (m) =>
        m.path === range.path &&
        range.startLine <= m.endLine + MERGE_GAP_LINES &&
        range.endLine >= m.startLine - MERGE_GAP_LINES &&
        Math.max(m.endLine, range.endLine) - Math.min(m.startLine, range.startLine) + 1 <= maxLines,
    );
    if (!target) {
      merged.push(range);
      continue;
    }
    target.startLine = Math.min(target.startLine, range.startLine);
    target.endLine = Math.max(target.endLine, range.endLine);
    for (const reason of range.reasons) if (!target.reasons.includes(reason)) target.reasons.push(reason);
    target.symbol ??= range.symbol;
  }
  return merged;
}

interface Page {
  excerpts: ContextExcerpt[];
  tokens: number;
  next: { i: number; l: number } | null;
  warnings: string[];
}

function materialize(
  db: Database,
  envelope: ResultEnvelope,
  candidates: readonly StoredCandidate[],
  start: { i: number; l: number },
  budget: number,
): Page {
  const excerpts: ContextExcerpt[] = [];
  const warnings: string[] = [];
  let tokens = 0;
  for (let i = start.i; i < candidates.length; i++) {
    const cand = candidates[i]!;
    const from = i === start.i && start.l > 0 ? start.l : cand.startLine;
    const lines = readLines(db, cand.blobSha, from, cand.endLine);
    if (lines.length === 0) continue;
    const text = lines.join('\n');
    const cost = estimateExcerptTokens(text);
    const remaining = budget - tokens;
    let take = lines.length;
    if (cost > remaining) {
      take = linesWithinBudget(lines, remaining);
      const mustProgress = excerpts.length === 0;
      if (take === 0 && mustProgress) take = 1;
      if (take === 0 || (!mustProgress && remaining < 128)) {
        warnings.push(
          `Budget exhausted after ${excerpts.length} excerpts; ${candidates.length - i} candidates remain (use nextCursor).`,
        );
        return { excerpts, tokens, next: { i, l: from }, warnings };
      }
    }
    const kept = lines.slice(0, take);
    const keptText = kept.join('\n');
    const endLine = from + kept.length - 1;
    const truncated = take < lines.length;
    excerpts.push({
      rank: i + 1,
      path: cand.path,
      startLine: from,
      endLine,
      blobSha: cand.blobSha,
      score: cand.score,
      symbol: cand.symbol,
      reasons: cand.reasons,
      tokenEstimate: estimateExcerptTokens(keptText),
      truncated,
      text: keptText,
      provenance: {
        repositoryId: envelope.repositoryId,
        commitSha: envelope.commitSha,
        path: cand.path,
        startLine: from,
        endLine,
        blobSha: cand.blobSha,
        retrievedAt: envelope.retrievedAt,
        indexStatus: envelope.indexStatus,
      },
    });
    tokens += estimateExcerptTokens(keptText);
    if (truncated) {
      warnings.push(
        `${cand.path}:${from}-${cand.endLine} truncated at line ${endLine} to fit the token budget; the remainder is on the next page.`,
      );
      return { excerpts, tokens, next: { i, l: endLine + 1 }, warnings };
    }
  }
  return { excerpts, tokens, next: null, warnings };
}

export async function buildContextPack(ctx: RailContext, input: ContextPackInput): Promise<ContextPack> {
  const config = input.config ?? DEFAULT_INDEX_CONFIG;
  const budget = Math.max(256, input.budgetTokens ?? config.max_context_tokens);
  const maxLines = Math.min(Math.max(input.maxExcerptLines ?? 60, 5), 400);
  const { envelope } = await requireSnapshot(ctx, input);
  const hints: { paths?: string[]; symbols?: string[] } = {};
  if (input.scope?.paths) hints.paths = input.scope.paths;
  if (input.scope?.symbols) hints.symbols = input.scope.symbols;
  const result = await search(ctx, {
    repositoryId: envelope.repositoryId,
    sha: envelope.commitSha,
    query: input.query,
    mode: 'hybrid',
    limit: Math.min(input.maxCandidates ?? 120, 500),
    contextLines: 6,
    hints,
    ...(input.filter ?? {}),
    embeddingProvider: input.embeddingProvider ?? null,
  });
  const warnings: string[] = [];
  const candidates = mergeCandidates(
    result.hits.map((h) => ({
      path: h.path,
      blobSha: h.blobSha,
      startLine: h.startLine,
      endLine: h.endLine,
      score: h.score,
      reasons: h.reasons,
      symbol: h.symbol,
    })),
    maxLines,
    warnings,
  );
  if (candidates.length === 0) warnings.push('No indexed content matched the query at this commit.');
  const page = materialize(ctx.store.db, envelope, candidates, { i: 0, l: 0 }, budget);
  const packId = newId('ctx');
  const payload: PackPayload = {
    version: 1,
    query: input.query,
    repositoryId: envelope.repositoryId,
    snapshotId: envelope.snapshotId,
    commitSha: envelope.commitSha,
    budgetTokens: budget,
    scope: input.scope ?? null,
    candidates,
    notes: result.notes,
  };
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) =>
    db
      .query(
        `INSERT INTO context_artifacts (id, kind, repository_id, snapshot_id, commit_sha, query, payload, token_estimate, created_at, expires_at)
         VALUES (?, 'context_pack', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        packId,
        envelope.repositoryId,
        envelope.snapshotId,
        envelope.commitSha,
        input.query,
        JSON.stringify(payload),
        page.tokens,
        at,
        addSeconds(at, (input.ttlHours ?? 168) * 3600),
      ),
  );
  return {
    ...envelope,
    packId,
    query: input.query,
    page: 1,
    budgetTokens: budget,
    tokenEstimate: page.tokens,
    tokenEstimator: TOKEN_ESTIMATOR,
    excerpts: page.excerpts,
    totalCandidates: candidates.length,
    warnings: [...warnings, ...page.warnings],
    notes: result.notes,
    nextCursor: page.next ? encodeCursor({ p: packId, ...page.next, n: 2 }) : null,
  };
}

export interface FetchPageInput {
  cursor: string;
  budgetTokens?: number;
}

export async function fetchContextPackPage(ctx: RailContext, input: FetchPageInput): Promise<ContextPack> {
  const cursor = decodeCursor(input.cursor);
  const row = one<{ payload: string; snapshot_id: string | null }>(
    ctx.store.db,
    "SELECT payload, snapshot_id FROM context_artifacts WHERE id = ? AND kind = 'context_pack'",
    cursor.p,
  );
  if (!row) throw new RailError('NOT_FOUND', `Context pack not found or expired: ${cursor.p}`);
  const payload = parseJson<PackPayload | null>(row.payload, null);
  if (!payload) throw new RailError('INTERNAL', `Context pack ${cursor.p} payload is unreadable`);
  const snapshot = snapshotByCommit(ctx.store.db, payload.repositoryId, payload.commitSha);
  if (!row.snapshot_id || snapshot?.id !== payload.snapshotId || snapshot.status !== 'available') {
    throw new RailError('INDEX_STALE', `Snapshot for ${payload.commitSha} is no longer available`, {
      details: { repositoryId: payload.repositoryId, commitSha: payload.commitSha },
      suggestion: indexCommand(payload.repositoryId, payload.commitSha),
    });
  }
  const envelope: ResultEnvelope = {
    repositoryId: payload.repositoryId,
    commitSha: payload.commitSha,
    snapshotId: payload.snapshotId,
    retrievedAt: nowIso(ctx.clock),
    indexStatus: 'fresh',
  };
  const budget = Math.max(256, input.budgetTokens ?? payload.budgetTokens);
  const page = materialize(ctx.store.db, envelope, payload.candidates, { i: cursor.i, l: cursor.l }, budget);
  return {
    ...envelope,
    packId: cursor.p,
    query: payload.query,
    page: cursor.n,
    budgetTokens: budget,
    tokenEstimate: page.tokens,
    tokenEstimator: TOKEN_ESTIMATOR,
    excerpts: page.excerpts,
    totalCandidates: payload.candidates.length,
    warnings: page.warnings,
    notes: payload.notes,
    nextCursor: page.next ? encodeCursor({ p: cursor.p, ...page.next, n: cursor.n + 1 }) : null,
  };
}
