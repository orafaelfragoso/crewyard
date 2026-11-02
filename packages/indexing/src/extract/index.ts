import { parseSource } from '../grammars.ts';
import type { ParserLanguage } from '../rules.ts';
import { Collector, type Extraction } from './collector.ts';
import { extractPython } from './python.ts';
import { extractRust } from './rust.ts';
import { extractTypeScript } from './typescript.ts';

export type { Extraction } from './collector.ts';

export async function extractSyntax(language: ParserLanguage, text: string): Promise<Extraction> {
  const tree = await parseSource(language, text);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${language}`);
  try {
    if (language === 'python') return extractPython(tree.rootNode);
    if (language === 'rust') return extractRust(tree.rootNode);
    return extractTypeScript(tree.rootNode);
  } finally {
    tree.delete();
  }
}

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function extractMarkdownLinks(lines: readonly string[]): Extraction {
  const out = new Collector();
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i]!.matchAll(MARKDOWN_LINK)) {
      const target = match[1]!.split('#')[0]!;
      if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      out.edge('reference', target, i + 1, null, 'file');
    }
  }
  return out.result();
}
