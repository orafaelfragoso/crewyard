import { CrewError } from '@crewyard/core';
import jsWasm from 'tree-sitter-javascript/tree-sitter-javascript.wasm' with { type: 'file' };
import pyWasm from 'tree-sitter-python/tree-sitter-python.wasm' with { type: 'file' };
import rsWasm from 'tree-sitter-rust/tree-sitter-rust.wasm' with { type: 'file' };
import tsxWasm from 'tree-sitter-typescript/tree-sitter-tsx.wasm' with { type: 'file' };
import tsWasm from 'tree-sitter-typescript/tree-sitter-typescript.wasm' with { type: 'file' };
import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION, Parser, type Tree } from 'web-tree-sitter';
import coreWasm from 'web-tree-sitter/web-tree-sitter.wasm' with { type: 'file' };
import type { ParserLanguage } from './rules.ts';

export const EXTRACTOR_REVISION = 1;

const GRAMMARS: Record<ParserLanguage, { wasm: string; id: string }> = {
  typescript: { wasm: tsWasm, id: 'tree-sitter-typescript@0.23.2' },
  tsx: { wasm: tsxWasm, id: 'tree-sitter-tsx@0.23.2' },
  javascript: { wasm: jsWasm, id: 'tree-sitter-javascript@0.25.0' },
  python: { wasm: pyWasm, id: 'tree-sitter-python@0.25.0' },
  rust: { wasm: rsWasm, id: 'tree-sitter-rust@0.24.0' },
};

export function parserId(language: ParserLanguage | null): string {
  return language === null ? `text#${EXTRACTOR_REVISION}` : `${GRAMMARS[language].id}#${EXTRACTOR_REVISION}`;
}

let initialized: Promise<void> | null = null;
const languages = new Map<ParserLanguage, Promise<Language>>();
let sharedParser: Parser | null = null;

async function loadLanguage(language: ParserLanguage): Promise<Language> {
  const loaded = await Language.load(await Bun.file(GRAMMARS[language].wasm).bytes());
  if (loaded.abiVersion < MIN_COMPATIBLE_VERSION || loaded.abiVersion > LANGUAGE_VERSION) {
    throw new CrewError(
      'UNSUPPORTED_CAPABILITY',
      `Grammar ${GRAMMARS[language].id} has ABI ${loaded.abiVersion}; web-tree-sitter supports ${MIN_COMPATIBLE_VERSION}-${LANGUAGE_VERSION}`,
      { retryable: false },
    );
  }
  return loaded;
}

export async function parseSource(language: ParserLanguage, text: string): Promise<Tree | null> {
  initialized ??= Parser.init({ locateFile: () => coreWasm });
  await initialized;
  let pending = languages.get(language);
  if (!pending) {
    pending = loadLanguage(language);
    languages.set(language, pending);
  }
  const grammar = await pending;
  sharedParser ??= new Parser();
  sharedParser.setLanguage(grammar);
  return sharedParser.parse(text);
}
