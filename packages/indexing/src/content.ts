import type { Database } from 'bun:sqlite';
import { REDACTED, redactSecrets, replacePrivateKeys } from '@crewyard/core';

export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  content: string;
}

const MIN_LINES_PER_CHUNK = 40;
const MAX_CHUNK_CHARS = 4_000;
export const MAX_CHUNKS_PER_BLOB = 4_096;
const SLOT_SPACE = 2 ** 40;
const MAX_PROBES = 4;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function redactPreservingLines(text: string): { text: string; redactions: number } {
  const { text: withoutKeys, count: blocks } = replacePrivateKeys(text, (block) =>
    block
      .split('\n')
      .map(() => REDACTED)
      .join('\n'),
  );
  const result = redactSecrets(withoutKeys);
  if (splitLines(result.text).length === splitLines(withoutKeys).length) {
    return { text: result.text, redactions: result.redactions + blocks };
  }
  let redactions = blocks;
  const lines = withoutKeys.split('\n').map((line) => {
    const redacted = redactSecrets(line);
    redactions += redacted.redactions;
    return redacted.text;
  });
  return { text: lines.join('\n'), redactions };
}

export function chunkLines(lines: readonly string[]): Chunk[] {
  const linesPerChunk = Math.max(MIN_LINES_PER_CHUNK, Math.ceil(lines.length / MAX_CHUNKS_PER_BLOB));
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < linesPerChunk) {
      chars += lines[end]!.length + 1;
      end++;
      const chunksLeft = MAX_CHUNKS_PER_BLOB - chunks.length - 1;
      if (chars >= MAX_CHUNK_CHARS && Math.ceil((lines.length - end) / linesPerChunk) <= chunksLeft) break;
    }
    chunks.push({
      index: chunks.length,
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join('\n'),
    });
    start = end;
  }
  return chunks;
}

function slotBase(blobSha: string, probe: number): number {
  const home = Number.parseInt(blobSha.slice(0, 10), 16);
  return ((home + probe) % SLOT_SPACE) * MAX_CHUNKS_PER_BLOB;
}

export function insertChunks(db: Database, blobSha: string, chunks: readonly Chunk[]): void {
  if (chunks.length === 0) return;
  const occupant = db.query<{ blob_sha: string }, [number, number]>(
    'SELECT blob_sha FROM fts_entries WHERE rowid BETWEEN ? AND ? LIMIT 1',
  );
  const insert = db.query(
    'INSERT INTO fts_entries (rowid, content, blob_sha, start_line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const base = slotBase(blobSha, probe);
    const existing = occupant.get(base, base + MAX_CHUNKS_PER_BLOB - 1);
    if (existing && existing.blob_sha !== blobSha) continue;
    if (existing) deleteChunksAt(db, base);
    for (const chunk of chunks) insert.run(base + chunk.index, chunk.content, blobSha, chunk.startLine, chunk.endLine);
    return;
  }
  throw new Error(`No free full-text slot for blob ${blobSha}`);
}

function deleteChunksAt(db: Database, base: number): void {
  db.query('DELETE FROM fts_entries WHERE rowid BETWEEN ? AND ?').run(base, base + MAX_CHUNKS_PER_BLOB - 1);
}

export interface StoredChunk {
  rowid: number;
  startLine: number;
  endLine: number;
  content: string;
}

export function readChunks(
  db: Database,
  blobSha: string,
  fromLine = 1,
  toLine = Number.MAX_SAFE_INTEGER,
): StoredChunk[] {
  const query = db.query<
    { rowid: number; blob_sha: string; start_line: number; end_line: number; content: string },
    [number, number, number, number]
  >(
    `SELECT rowid, blob_sha, start_line, end_line, content FROM fts_entries
     WHERE rowid BETWEEN ? AND ? AND end_line >= ? AND start_line <= ? ORDER BY rowid`,
  );
  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const base = slotBase(blobSha, probe);
    const rows = query.all(base, base + MAX_CHUNKS_PER_BLOB - 1, fromLine, toLine);
    if (rows.length > 0 && rows[0]!.blob_sha === blobSha) {
      return rows.map((r) => ({ rowid: r.rowid, startLine: r.start_line, endLine: r.end_line, content: r.content }));
    }
  }
  return [];
}

export function deleteChunks(db: Database, blobSha: string): void {
  const occupant = db.query<{ blob_sha: string }, [number, number]>(
    'SELECT blob_sha FROM fts_entries WHERE rowid BETWEEN ? AND ? LIMIT 1',
  );
  for (let probe = 0; probe < MAX_PROBES; probe++) {
    const base = slotBase(blobSha, probe);
    if (occupant.get(base, base + MAX_CHUNKS_PER_BLOB - 1)?.blob_sha === blobSha) {
      deleteChunksAt(db, base);
      return;
    }
  }
}

export function readLines(db: Database, blobSha: string, startLine: number, endLine: number): string[] {
  const out: string[] = [];
  for (const chunk of readChunks(db, blobSha, startLine, endLine)) {
    const lines = chunk.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = chunk.startLine + i;
      if (line >= startLine && line <= endLine) out.push(lines[i]!);
    }
  }
  return out;
}

export function readText(db: Database, blobSha: string): string {
  return readChunks(db, blobSha)
    .map((c) => c.content)
    .join('\n');
}
