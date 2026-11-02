import type { ConfidenceTier } from '@crewyard/core';
import { all, type CrewContext } from '@crewyard/storage';
import { readLines } from './content.ts';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import { SYNTAX_NOTE, snapshotModel } from './graph.ts';
import { querySymbols, type SymbolMatch, splitQualified, toSymbolInfo } from './search.ts';
import type { EdgeKind, Provenance, ResultEnvelope, SymbolInfo } from './types.ts';

export interface FindSymbolInput extends SnapshotRequest {
  name: string;
  kind?: string;
  path?: string;
  match?: SymbolMatch;
  exportedOnly?: boolean;
  limit?: number;
}

export interface SymbolDefinition extends SymbolInfo {
  path: string;
  blobSha: string;
  packageRoot: string | null;
  provenance: Provenance;
}

export interface FindSymbolResult extends ResultEnvelope {
  query: string;
  definitions: SymbolDefinition[];
  note: string;
}

export async function findSymbol(ctx: CrewContext, input: FindSymbolInput): Promise<FindSymbolResult> {
  const { snapshot, envelope } = await requireSnapshot(ctx, input);
  const model = snapshotModel(ctx.store, snapshot);
  const q = splitQualified(input.name.trim());
  const extra: { kind?: string; container?: string } = {};
  if (input.kind) extra.kind = input.kind;
  if (q.container) extra.container = q.container;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 1_000);
  const rows = querySymbols(ctx.store.db, snapshot.id, q.name, input.match ?? 'exact', limit * 2, extra);
  const definitions = rows
    .filter((r) => (!input.path || r.path === input.path) && (!input.exportedOnly || r.exported === 1))
    .slice(0, limit)
    .map((r) => ({
      ...toSymbolInfo(r),
      path: r.path,
      blobSha: r.blob_sha,
      packageRoot: model.byPath.get(r.path)?.package_root ?? null,
      provenance: {
        repositoryId: envelope.repositoryId,
        commitSha: envelope.commitSha,
        path: r.path,
        startLine: r.start_line,
        endLine: r.end_line,
        blobSha: r.blob_sha,
        retrievedAt: envelope.retrievedAt,
        indexStatus: envelope.indexStatus,
      },
    }));
  return { ...envelope, query: input.name, definitions, note: SYNTAX_NOTE };
}

export interface FindReferencesInput extends SnapshotRequest {
  name: string;
  definitionPath?: string;
  limit?: number;
}

export interface SymbolReference {
  path: string;
  line: number;
  kind: EdgeKind;
  sourceSymbol: string | null;
  confidence: ConfidenceTier;
  resolution: 'syntax';
  excerpt: string;
  provenance: Provenance;
}

export interface FindReferencesResult extends ResultEnvelope {
  query: string;
  definitions: SymbolDefinition[];
  references: SymbolReference[];
  truncated: boolean;
  note: string;
}

export async function findReferences(ctx: CrewContext, input: FindReferencesInput): Promise<FindReferencesResult> {
  const defs = await findSymbol(ctx, {
    ...input,
    limit: 50,
    ...(input.definitionPath ? { path: input.definitionPath } : {}),
  });
  const { snapshot } = await requireSnapshot(ctx, { repositoryId: input.repositoryId, sha: defs.commitSha });
  const model = snapshotModel(ctx.store, snapshot);
  const { name } = splitQualified(input.name.trim());
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2_000);
  const definitionPaths = new Set(defs.definitions.map((d) => d.path));
  const importsDefinition = (path: string) =>
    (model.imports.get(path) ?? []).some((l) => l.to !== null && definitionPaths.has(l.to));

  const rows = all<{
    path: string;
    blob_sha: string;
    kind: EdgeKind;
    source_symbol: string | null;
    line: number | null;
  }>(
    ctx.store.db,
    `SELECT f.path, f.blob_sha, e.kind, e.source_symbol, e.line
     FROM symbol_edges e JOIN files f ON f.blob_sha = e.blob_sha AND f.snapshot_id = ?
     WHERE e.target = ? AND e.kind IN ('call', 'reference') AND e.line IS NOT NULL
     ORDER BY f.path, e.line`,
    snapshot.id,
    name,
  );
  const refs: { path: string; blobSha: string; kind: EdgeKind; sourceSymbol: string | null; line: number }[] = rows.map(
    (r) => ({
      path: r.path,
      blobSha: r.blob_sha,
      kind: r.kind,
      sourceSymbol: r.source_symbol,
      line: r.line!,
    }),
  );
  for (const links of model.imports.values()) {
    for (const link of links) {
      if (!link.names.includes(name) || link.line === null) continue;
      refs.push({
        path: link.from,
        blobSha: model.byPath.get(link.from)!.blob_sha,
        kind: 'import',
        sourceSymbol: null,
        line: link.line,
      });
    }
  }
  refs.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const truncated = refs.length > limit;
  const references = refs.slice(0, limit).map((r) => {
    const confidence: ConfidenceTier =
      definitionPaths.has(r.path) || importsDefinition(r.path) ? 'structural' : 'heuristic';
    return {
      path: r.path,
      line: r.line,
      kind: r.kind,
      sourceSymbol: r.sourceSymbol,
      confidence,
      resolution: 'syntax' as const,
      excerpt: readLines(ctx.store.db, r.blobSha, r.line, r.line).join('\n'),
      provenance: {
        repositoryId: defs.repositoryId,
        commitSha: defs.commitSha,
        path: r.path,
        startLine: r.line,
        endLine: r.line,
        blobSha: r.blobSha,
        retrievedAt: defs.retrievedAt,
        indexStatus: defs.indexStatus,
      },
    };
  });
  return { ...defs, definitions: defs.definitions, references, truncated, note: SYNTAX_NOTE };
}
