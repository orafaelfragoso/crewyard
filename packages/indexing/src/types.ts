import type { CrewConfig } from '@crewyard/config';

export type IndexConfig = CrewConfig['index'];

export type SnapshotStatus = 'building' | 'available' | 'failed' | 'stale';
export type IndexStatus = 'fresh' | 'stale' | 'building' | 'missing' | 'failed';
export type FileKind = 'source' | 'test' | 'doc' | 'config' | 'manifest' | 'workflow' | 'other';
export type ParseStatus = 'parsed' | 'text' | 'skipped' | 'redacted' | 'error';
export type EdgeKind = 'import' | 'export' | 'reference' | 'call';
export type EdgeResolution = 'syntax' | 'file' | 'lsp' | 'scip';

export interface SnapshotSelector {
  repositoryId: string;
  sha?: string;
  ref?: string;
  worktreePath?: string;
}

export interface Snapshot {
  id: string;
  repositoryId: string;
  commitSha: string;
  treeSha: string | null;
  ref: string | null;
  parentSnapshotId: string | null;
  status: SnapshotStatus;
  fileCount: number;
  changedCount: number;
  parsedCount: number;
  revision: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface Provenance {
  repositoryId: string;
  commitSha: string;
  path: string;
  startLine: number;
  endLine: number;
  blobSha: string;
  retrievedAt: string;
  indexStatus: IndexStatus;
}

export interface ResultEnvelope {
  repositoryId: string;
  commitSha: string;
  snapshotId: string;
  retrievedAt: string;
  indexStatus: IndexStatus;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  container: string | null;
  exported: boolean;
  signature: string | null;
  startLine: number;
  endLine: number;
}

export interface ExtractedEdge {
  kind: EdgeKind;
  sourceSymbol: string | null;
  target: string;
  line: number | null;
  resolution: EdgeResolution;
}
