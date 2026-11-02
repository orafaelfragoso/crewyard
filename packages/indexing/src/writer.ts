import type { Database } from 'bun:sqlite';
import { deleteChunks, insertChunks } from './content.ts';
import type { BlobRecord } from './process.ts';
import type { FileKind } from './types.ts';

export interface FileRow {
  path: string;
  blobSha: string;
  language: string | null;
  size: number;
  kind: FileKind;
  packageRoot: string | null;
}

export function writeBlobs(
  db: Database,
  records: readonly BlobRecord[],
  replace: ReadonlySet<string>,
  at: string,
): number {
  const insertBlob = db.query(
    `INSERT OR IGNORE INTO blobs (sha, language, size, line_count, parse_status, parser, redactions, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateBlob = db.query(
    `UPDATE blobs SET language = ?, size = ?, line_count = ?, parse_status = ?, parser = ?, redactions = ?, indexed_at = ?
     WHERE sha = ?`,
  );
  const insertSymbol = db.query(
    `INSERT INTO symbols (blob_sha, name, kind, start_line, end_line, exported, signature, container)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.query(
    `INSERT INTO symbol_edges (blob_sha, kind, source_symbol, target, resolved_path, line, resolution)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  );
  let written = 0;
  for (const r of records) {
    if (replace.has(r.sha)) {
      const updated = updateBlob.run(r.language, r.size, r.lineCount, r.parseStatus, r.parser, r.redactions, at, r.sha);
      if (updated.changes > 0) {
        db.query('DELETE FROM symbols WHERE blob_sha = ?').run(r.sha);
        db.query('DELETE FROM symbol_edges WHERE blob_sha = ?').run(r.sha);
        db.query('DELETE FROM embeddings WHERE blob_sha = ?').run(r.sha);
        deleteChunks(db, r.sha);
      } else {
        insertBlob.run(r.sha, r.language, r.size, r.lineCount, r.parseStatus, r.parser, r.redactions, at);
      }
    } else if (
      insertBlob.run(r.sha, r.language, r.size, r.lineCount, r.parseStatus, r.parser, r.redactions, at).changes === 0
    ) {
      continue;
    }
    written++;
    for (const s of r.extraction.symbols) {
      insertSymbol.run(r.sha, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0, s.signature, s.container);
    }
    for (const e of r.extraction.edges) insertEdge.run(r.sha, e.kind, e.sourceSymbol, e.target, e.line, e.resolution);
    insertChunks(db, r.sha, r.chunks);
  }
  return written;
}

export function writeFiles(db: Database, snapshotId: string, rows: readonly FileRow[]): void {
  const insert = db.query(
    `INSERT OR REPLACE INTO files (snapshot_id, path, blob_sha, language, size, kind, package_root)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows)
    insert.run(snapshotId, row.path, row.blobSha, row.language, row.size, row.kind, row.packageRoot);
}
