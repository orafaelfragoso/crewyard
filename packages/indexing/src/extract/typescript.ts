import type { Node } from 'web-tree-sitter';
import {
  Collector,
  type Extraction,
  headerSignature,
  isDeclarationName,
  lineOf,
  MAX_DEPTH,
  normalizeSignature,
  unquote,
} from './collector.ts';

interface Scope {
  container: string | null;
  enclosing: string | null;
  exported: boolean;
  depth: number;
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

const DECLARATIONS: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  internal_module: 'namespace',
  module: 'namespace',
};

const TYPE_LIKE = new Set(['interface', 'type', 'enum']);

export function extractTypeScript(root: Node): Extraction {
  const out = new Collector();
  const exportedNames = new Set<string>();

  const importEdges = (spec: string, clause: Node | null, line: number) => {
    if (!clause) {
      out.edge('import', spec, line, null);
      return;
    }
    for (const child of clause.namedChildren) {
      if (!child) continue;
      if (child.type === 'identifier') out.edge('import', spec, line, 'default');
      else if (child.type === 'namespace_import') out.edge('import', spec, line, '*');
      else if (child.type === 'named_imports') {
        for (const specifier of child.namedChildren) {
          const name = specifier?.childForFieldName('name')?.text;
          if (name) out.edge('import', spec, line, name);
        }
      }
    }
  };

  const exportStatement = (node: Node, scope: Scope) => {
    const line = lineOf(node);
    const source = node.childForFieldName('source');
    const declaration = node.childForFieldName('declaration');
    const clause = node.namedChildren.find((c) => c?.type === 'export_clause') ?? null;
    if (source) {
      const spec = unquote(source.text);
      if (!clause) {
        out.edge('import', spec, line, '*');
        out.edge('export', '*', line, spec);
      }
    }
    if (clause) {
      for (const specifier of clause.namedChildren) {
        const name = specifier?.childForFieldName('name')?.text;
        if (!name) continue;
        const alias = specifier?.childForFieldName('alias')?.text ?? name;
        out.edge('export', alias, line, name);
        if (source) out.edge('import', unquote(source.text), line, name);
        else exportedNames.add(name);
      }
    }
    if (declaration) {
      visit(declaration, { ...scope, exported: true });
      return;
    }
    const value = node.childForFieldName('value');
    if (value) {
      out.edge('export', 'default', line, value.type === 'identifier' ? value.text : null);
      if (value.type === 'identifier') exportedNames.add(value.text);
      visit(value, scope);
    } else {
      for (const child of node.namedChildren) {
        if (child && child.type !== 'export_clause' && child.id !== source?.id)
          visit(child, { ...scope, exported: true });
      }
    }
  };

  const variableDeclaration = (node: Node, scope: Scope) => {
    const keyword = node.child(0)?.text === 'const' ? 'const' : 'variable';
    for (const declarator of node.namedChildren) {
      if (declarator?.type !== 'variable_declarator') continue;
      const nameNode = declarator.childForFieldName('name');
      const value = declarator.childForFieldName('value');
      const topLevel = scope.container === null && scope.enclosing === null;
      if (nameNode?.type === 'identifier' && (topLevel || scope.exported)) {
        const isFunction = value !== null && FUNCTION_VALUES.has(value.type);
        const signature = isFunction
          ? normalizeSignature(`${nameNode.text} = ${headerSignature(value)}`)
          : normalizeSignature(declarator.text.slice(0, 200));
        out.symbol(declarator, nameNode.text, isFunction ? 'function' : keyword, {
          exported: scope.exported,
          signature,
        });
        if (value) visit(value, { ...scope, exported: false, enclosing: isFunction ? nameNode.text : scope.enclosing });
        continue;
      }
      if (value) visit(value, { ...scope, exported: false });
    }
  };

  const callExpression = (node: Node, scope: Scope) => {
    const fn = node.childForFieldName('function');
    const args = node.childForFieldName('arguments');
    const firstArg = args?.namedChildren[0] ?? null;
    if (fn && (fn.text === 'require' || fn.type === 'import') && firstArg?.type === 'string') {
      out.edge('import', unquote(firstArg.text), lineOf(node), fn.text === 'require' ? '*' : 'dynamic');
    } else if (fn?.type === 'identifier') out.edge('call', fn.text, lineOf(node), scope.enclosing);
    else if (fn?.type === 'member_expression') {
      const property = fn.childForFieldName('property')?.text;
      if (property) out.edge('call', property, lineOf(node), scope.enclosing);
    }
  };

  const visit = (node: Node, scope: Scope): void => {
    if (scope.depth > MAX_DEPTH) return;
    const next: Scope = { ...scope, depth: scope.depth + 1, exported: false };
    switch (node.type) {
      case 'import_statement': {
        const source = node.childForFieldName('source');
        if (source) {
          const clause = node.namedChildren.find((c) => c?.type === 'import_clause') ?? null;
          importEdges(unquote(source.text), clause, lineOf(node));
        }
        return;
      }
      case 'export_statement':
        exportStatement(node, scope);
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        variableDeclaration(node, scope);
        return;
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature': {
        const name = node.childForFieldName('name')?.text ?? '';
        out.symbol(node, name, 'method', { container: scope.container, signature: headerSignature(node) });
        for (const child of node.namedChildren) if (child) visit(child, { ...next, enclosing: name });
        return;
      }
      case 'call_expression':
        callExpression(node, scope);
        break;
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        if (ctor?.type === 'identifier') out.edge('reference', ctor.text, lineOf(node), scope.enclosing);
        break;
      }
      case 'type_identifier':
        if (!isDeclarationName(node)) out.edge('reference', node.text, lineOf(node), scope.enclosing);
        return;
    }
    const kind = DECLARATIONS[node.type];
    if (kind) {
      const name = node.childForFieldName('name')?.text ?? '';
      const signature = TYPE_LIKE.has(kind) ? normalizeSignature(node.text) : headerSignature(node);
      out.symbol(node, name, kind, { container: scope.container, exported: scope.exported, signature });
      const body = node.childForFieldName('body');
      const inner: Scope =
        kind === 'class' || kind === 'namespace' || kind === 'interface'
          ? { ...next, container: name }
          : { ...next, enclosing: name };
      for (const child of node.namedChildren) if (child && child.id !== body?.id) visit(child, inner);
      if (body) for (const child of body.namedChildren) if (child) visit(child, inner);
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child, next);
  };

  for (const child of root.namedChildren)
    if (child) visit(child, { container: null, enclosing: null, exported: false, depth: 0 });
  for (const symbol of out.symbols) {
    if (symbol.container === null && exportedNames.has(symbol.name)) symbol.exported = true;
  }
  return out.result();
}
