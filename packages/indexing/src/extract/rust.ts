import type { Node } from 'web-tree-sitter';
import {
  Collector,
  type Extraction,
  headerSignature,
  isDeclarationName,
  lineOf,
  MAX_DEPTH,
  normalizeSignature,
} from './collector.ts';

interface Scope {
  container: string | null;
  enclosing: string | null;
  depth: number;
}

const ITEMS: Record<string, string> = {
  struct_item: 'struct',
  union_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  type_item: 'type',
  const_item: 'const',
  static_item: 'const',
  macro_definition: 'macro',
};

const TYPE_LIKE = new Set(['struct', 'enum', 'type', 'const']);

function isPublic(node: Node): boolean {
  return node.namedChildren.some((c) => c?.type === 'visibility_modifier' && c.text.startsWith('pub'));
}

function typeName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === 'generic_type') return typeName(node.childForFieldName('type'));
  if (node.type === 'scoped_type_identifier') return node.childForFieldName('name')?.text ?? null;
  return node.text;
}

function flattenUse(node: Node, prefix: string, out: (path: string, alias: string | null) => void): void {
  switch (node.type) {
    case 'use_as_clause': {
      const path = node.childForFieldName('path');
      if (path) out(prefix + path.text, node.childForFieldName('alias')?.text ?? null);
      return;
    }
    case 'scoped_use_list': {
      const path = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const next = path ? `${prefix}${path.text}::` : prefix;
      for (const child of list?.namedChildren ?? []) if (child) flattenUse(child, next, out);
      return;
    }
    case 'use_list':
      for (const child of node.namedChildren) if (child) flattenUse(child, prefix, out);
      return;
    case 'use_wildcard':
      out(prefix + node.text, null);
      return;
    default:
      out(prefix + node.text, null);
  }
}

export function extractRust(root: Node): Extraction {
  const out = new Collector();

  const visit = (node: Node, scope: Scope): void => {
    if (scope.depth > MAX_DEPTH) return;
    const next: Scope = { ...scope, depth: scope.depth + 1 };
    switch (node.type) {
      case 'use_declaration': {
        const argument = node.childForFieldName('argument');
        if (argument) {
          flattenUse(argument, '', (path) => {
            const segments = path.split('::');
            const last = segments[segments.length - 1] ?? '';
            if (last === '*') out.edge('import', segments.slice(0, -1).join('::'), lineOf(node), '*');
            else
              out.edge('import', path, lineOf(node), last === 'self' ? (segments[segments.length - 2] ?? null) : last);
          });
        }
        return;
      }
      case 'mod_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        const body = node.childForFieldName('body');
        out.symbol(node, name, 'module', {
          container: scope.container,
          exported: isPublic(node),
          signature: `mod ${name}`,
        });
        if (!body) out.edge('import', `self::${name}`, lineOf(node), name);
        for (const child of body?.namedChildren ?? []) if (child) visit(child, { ...next, container: name });
        return;
      }
      case 'function_item':
      case 'function_signature_item': {
        const name = node.childForFieldName('name')?.text ?? '';
        const kind = scope.container !== null && scope.enclosing === null ? 'method' : 'function';
        out.symbol(node, name, kind, {
          container: scope.container,
          exported: isPublic(node),
          signature: headerSignature(node),
        });
        for (const child of node.namedChildren) if (child) visit(child, { ...next, enclosing: name });
        return;
      }
      case 'impl_item': {
        const self = typeName(node.childForFieldName('type'));
        const trait = typeName(node.childForFieldName('trait'));
        if (trait) out.edge('reference', trait, lineOf(node), self);
        if (self) out.edge('reference', self, lineOf(node), null);
        const body = node.childForFieldName('body');
        for (const child of body?.namedChildren ?? []) if (child) visit(child, { ...next, container: self });
        return;
      }
      case 'call_expression': {
        let fn = node.childForFieldName('function');
        if (fn?.type === 'generic_function') fn = fn.childForFieldName('function');
        const name =
          fn?.type === 'identifier'
            ? fn.text
            : fn?.type === 'scoped_identifier'
              ? fn.childForFieldName('name')?.text
              : fn?.type === 'field_expression'
                ? fn.childForFieldName('field')?.text
                : undefined;
        if (name) out.edge('call', name, lineOf(node), scope.enclosing);
        break;
      }
      case 'type_identifier':
        if (!isDeclarationName(node)) out.edge('reference', node.text, lineOf(node), scope.enclosing);
        return;
    }
    const kind = ITEMS[node.type];
    if (kind) {
      const name = node.childForFieldName('name')?.text ?? '';
      const signature = TYPE_LIKE.has(kind) ? normalizeSignature(node.text) : headerSignature(node);
      out.symbol(node, name, kind, { container: scope.container, exported: isPublic(node), signature });
      const inner: Scope = kind === 'trait' ? { ...next, container: name } : next;
      for (const child of node.namedChildren) if (child) visit(child, inner);
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child, next);
  };

  for (const child of root.namedChildren) if (child) visit(child, { container: null, enclosing: null, depth: 0 });
  return out.result();
}
