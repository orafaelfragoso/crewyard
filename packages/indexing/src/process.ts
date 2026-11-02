import { type Chunk, chunkLines, redactPreservingLines, splitLines } from './content.ts';
import { type Extraction, extractMarkdownLinks, extractSyntax } from './extract/index.ts';
import { EXTRACTOR_REVISION, parserId } from './grammars.ts';
import { hasBinaryContent, looksGenerated, type ParserLanguage } from './rules.ts';
import type { ParseStatus } from './types.ts';

export const SKIP_PARSER = `skip#${EXTRACTOR_REVISION}`;

export interface BlobPlan {
  sha: string;
  path: string;
  language: string | null;
  parserLanguage: ParserLanguage | null;
  size: number;
  contentIndexed: boolean;
}

export interface BlobRecord {
  sha: string;
  language: string | null;
  size: number;
  lineCount: number;
  parseStatus: ParseStatus;
  parser: string;
  redactions: number;
  chunks: Chunk[];
  extraction: Extraction;
}

const EMPTY: Extraction = { symbols: [], edges: [] };
const decoder = new TextDecoder('utf-8');

export function expectedParser(plan: Pick<BlobPlan, 'contentIndexed' | 'parserLanguage'>): string {
  return plan.contentIndexed ? parserId(plan.parserLanguage) : SKIP_PARSER;
}

export function skippedRecord(plan: BlobPlan, size: number): BlobRecord {
  return {
    sha: plan.sha,
    language: plan.language,
    size,
    lineCount: 0,
    parseStatus: 'skipped',
    parser: expectedParser(plan),
    redactions: 0,
    chunks: [],
    extraction: EMPTY,
  };
}

export interface PreparedText {
  lines: string[];
  redactions: number;
  chunks: Chunk[];
}

export function prepareText(bytes: Uint8Array): PreparedText | null {
  if (hasBinaryContent(bytes)) return null;
  const raw = decoder.decode(bytes);
  const rawLines = splitLines(raw);
  if (looksGenerated(raw, rawLines.length)) return null;
  const redacted = redactPreservingLines(raw);
  const lines = splitLines(redacted.text);
  return { lines, redactions: redacted.redactions, chunks: chunkLines(lines) };
}

export async function processBlob(plan: BlobPlan, bytes: Uint8Array | null, size: number): Promise<BlobRecord> {
  if (!plan.contentIndexed || bytes === null) return skippedRecord(plan, size);
  const prepared = prepareText(bytes);
  if (prepared === null) return skippedRecord(plan, size);
  let extraction = EMPTY;
  let status: ParseStatus = 'text';
  if (plan.parserLanguage !== null) {
    try {
      extraction = await extractSyntax(plan.parserLanguage, prepared.lines.join('\n'));
      status = 'parsed';
    } catch {
      status = 'error';
    }
  } else if (plan.language === 'markdown') {
    extraction = extractMarkdownLinks(prepared.lines);
  }
  if (prepared.redactions > 0) status = 'redacted';
  return {
    sha: plan.sha,
    language: plan.language,
    size,
    lineCount: prepared.lines.length,
    parseStatus: status,
    parser: expectedParser(plan),
    redactions: prepared.redactions,
    chunks: prepared.chunks,
    extraction,
  };
}
