import type { Node } from 'web-tree-sitter';
import type { EdgeKind, EdgeResolution, ExtractedEdge, SymbolInfo } from '../types.ts';

const MAX_SYMBOLS = 5_000;
const MAX_EDGES = 10_000;
const MAX_SIGNATURE = 2_000;
export const MAX_DEPTH = 400;

export interface Extraction {
  symbols: SymbolInfo[];
  edges: ExtractedEdge[];
}

export class Collector {
  readonly symbols: SymbolInfo[] = [];
  readonly edges: ExtractedEdge[] = [];
  private readonly edgeKeys = new Set<string>();

  symbol(
    node: Node,
    name: string,
    kind: string,
    options: { container?: string | null; exported?: boolean; signature?: string | null },
  ): void {
    if (this.symbols.length >= MAX_SYMBOLS || name === '') return;
    this.symbols.push({
      name,
      kind,
      container: options.container ?? null,
      exported: options.exported ?? false,
      signature: options.signature ?? null,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    });
  }

  edge(
    kind: EdgeKind,
    target: string,
    line: number | null,
    sourceSymbol: string | null,
    resolution: EdgeResolution = 'syntax',
  ): void {
    if (this.edges.length >= MAX_EDGES || target === '') return;
    const key = `${kind}\0${target}\0${line}\0${sourceSymbol}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ kind, target, line, sourceSymbol, resolution });
  }

  result(): Extraction {
    return { symbols: this.symbols, edges: this.edges };
  }
}

export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function normalizeSignature(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SIGNATURE ? `${flat.slice(0, MAX_SIGNATURE)}…` : flat;
}

export function headerSignature(node: Node, bodyField = 'body'): string {
  const body = node.childForFieldName(bodyField);
  const text = body ? node.text.slice(0, body.startIndex - node.startIndex) : node.text;
  return normalizeSignature(text.replace(/[\s:]+$/, ''));
}

export function unquote(text: string): string {
  return text.replace(/^(['"`])([\s\S]*)\1$/, '$2');
}

export function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  return parent !== null && parent.childForFieldName('name')?.id === node.id;
}
