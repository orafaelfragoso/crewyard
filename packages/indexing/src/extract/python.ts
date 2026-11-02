import type { Node } from 'web-tree-sitter';
import {
  Collector,
  type Extraction,
  headerSignature,
  lineOf,
  MAX_DEPTH,
  normalizeSignature,
  unquote,
} from './collector.ts';

interface Scope {
  container: string | null;
  enclosing: string | null;
  depth: number;
}

function importedName(node: Node): string | null {
  if (node.type === 'dotted_name') return node.text;
  if (node.type === 'aliased_import') return node.childForFieldName('name')?.text ?? null;
  return null;
}

export function extractPython(root: Node): Extraction {
  const out = new Collector();
  let declaredAll: Set<string> | null = null;

  const visit = (node: Node, scope: Scope): void => {
    if (scope.depth > MAX_DEPTH) return;
    const next: Scope = { ...scope, depth: scope.depth + 1 };
    const topLevel = scope.container === null && scope.enclosing === null;
    switch (node.type) {
      case 'import_statement':
        for (const child of node.childrenForFieldName('name')) {
          const name = child ? importedName(child) : null;
          if (name) out.edge('import', name, lineOf(node), null);
        }
        return;
      case 'import_from_statement': {
        const module = node.childForFieldName('module_name')?.text ?? '';
        const names = node.childrenForFieldName('name');
        if (node.namedChildren.some((c) => c?.type === 'wildcard_import'))
          out.edge('import', module, lineOf(node), '*');
        for (const child of names) {
          const name = child ? importedName(child) : null;
          if (name) out.edge('import', module, lineOf(node), name);
        }
        return;
      }
      case 'decorated_definition': {
        const definition = node.childForFieldName('definition');
        for (const child of node.namedChildren) if (child && child.id !== definition?.id) visit(child, next);
        if (definition) visit(definition, scope);
        return;
      }
      case 'class_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        out.symbol(node, name, 'class', { container: scope.container, signature: headerSignature(node) });
        const superclasses = node.childForFieldName('superclasses');
        for (const base of superclasses?.namedChildren ?? []) {
          if (base?.type === 'identifier' || base?.type === 'attribute')
            out.edge('reference', base.text, lineOf(base), name);
        }
        const body = node.childForFieldName('body');
        for (const child of body?.namedChildren ?? []) if (child) visit(child, { ...next, container: name });
        return;
      }
      case 'function_definition': {
        const name = node.childForFieldName('name')?.text ?? '';
        const kind = scope.container !== null && scope.enclosing === null ? 'method' : 'function';
        out.symbol(node, name, kind, { container: scope.container, signature: headerSignature(node) });
        for (const child of node.namedChildren) if (child) visit(child, { ...next, enclosing: name });
        return;
      }
      case 'assignment': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (topLevel && left?.type === 'identifier') {
          if (left.text === '__all__' && right && (right.type === 'list' || right.type === 'tuple')) {
            declaredAll = new Set(right.namedChildren.filter((c) => c?.type === 'string').map((c) => unquote(c!.text)));
          }
          out.symbol(node, left.text, 'variable', { signature: normalizeSignature(node.text.slice(0, 200)) });
        }
        if (right) visit(right, next);
        return;
      }
      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'identifier') out.edge('call', fn.text, lineOf(node), scope.enclosing);
        else if (fn?.type === 'attribute') {
          const attr = fn.childForFieldName('attribute')?.text;
          if (attr) out.edge('call', attr, lineOf(node), scope.enclosing);
        }
        break;
      }
    }
    for (const child of node.namedChildren) if (child) visit(child, next);
  };

  for (const child of root.namedChildren) if (child) visit(child, { container: null, enclosing: null, depth: 0 });
  const all = declaredAll as Set<string> | null;
  for (const symbol of out.symbols) {
    if (symbol.container !== null) continue;
    symbol.exported = all ? all.has(symbol.name) : !symbol.name.startsWith('_');
  }
  const exportedClasses = new Set(out.symbols.filter((s) => s.container === null && s.exported).map((s) => s.name));
  for (const symbol of out.symbols) {
    if (symbol.container !== null && symbol.kind === 'method' && !symbol.name.startsWith('_')) {
      symbol.exported = exportedClasses.has(symbol.container);
    }
  }
  return out.result();
}
