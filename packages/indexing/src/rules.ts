import type { FileKind, IndexConfig } from './types.ts';

export type ParserLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'rust';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  css: 'css',
  scss: 'css',
  html: 'html',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'markdown',
  rst: 'rst',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  txt: 'text',
};

const SOURCE_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'python',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'ruby',
  'php',
  'c',
  'cpp',
  'csharp',
  'shell',
  'powershell',
  'sql',
  'css',
  'html',
  'vue',
  'svelte',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'go.mod',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'deno.json',
  'requirements.txt',
]);

export const PACKAGE_MANIFESTS = new Set(['package.json', 'Cargo.toml', 'pyproject.toml']);

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
]);

const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\.(json|ya?ml|toml|ini|xml))?$/i,
  /^\.(netrc|npmrc|pypirc|pgpass|git-credentials|htpasswd)$/i,
  /^(secrets?|service[-_]account.*)\.(json|ya?ml|toml)$/i,
  /^.*\.tfstate(\.backup)?$/i,
];

const GENERATED_DIR = /(^|\/)(node_modules|vendor|target|dist|out|__pycache__|\.next|\.nuxt|coverage|\.venv|venv)\//;
const GENERATED_FILE = /(\.min\.(js|css|mjs)|\.map|\.generated\.\w+|_pb2\.py|_pb2_grpc\.py|\.pb\.go|\.snap)$/i;

export function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function extensionOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function detectLanguage(path: string): string | null {
  const base = basenameOf(path);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return 'dockerfile';
  if (base === 'Makefile' || base === 'GNUmakefile') return 'make';
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

export function parserLanguageFor(path: string, language: string | null, config: IndexConfig): ParserLanguage | null {
  if (language === null || !(config.languages as readonly string[]).includes(language)) return null;
  const ext = extensionOf(path);
  if (language === 'typescript') return ext === 'tsx' ? 'tsx' : 'typescript';
  if (language === 'javascript') return 'javascript';
  if (language === 'python') return 'python';
  if (language === 'rust') return 'rust';
  return null;
}

export function isTestPath(path: string): boolean {
  const base = basenameOf(path);
  return (
    /(^|\/)(tests?|__tests__|spec|specs|e2e)\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go|rs)$/.test(base) ||
    /^conftest\.py$/.test(base)
  );
}

export function classifyFile(path: string, language: string | null): FileKind {
  const base = basenameOf(path);
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return 'workflow';
  if (MANIFEST_NAMES.has(base) || LOCKFILES.has(base) || /^requirements.*\.txt$/.test(base)) return 'manifest';
  if (isTestPath(path) && language !== null && SOURCE_LANGUAGES.has(language)) return 'test';
  if (language === 'markdown' || language === 'rst' || /^(readme|changelog|license|contributing)(\.|$)/i.test(base)) {
    return 'doc';
  }
  if (language !== null && SOURCE_LANGUAGES.has(language)) return 'source';
  if (
    ['json', 'yaml', 'toml', 'xml', 'dockerfile', 'make'].includes(language ?? '') ||
    /^\.[\w.-]+rc$/.test(base) ||
    ['.gitignore', '.gitattributes', '.editorconfig'].includes(base)
  ) {
    return 'config';
  }
  if (path.startsWith('docs/') || path.includes('/docs/')) return 'doc';
  return 'other';
}

export function isSecretFile(path: string): boolean {
  const base = basenameOf(path);
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

export function isGeneratedPath(path: string): boolean {
  return LOCKFILES.has(basenameOf(path)) || GENERATED_DIR.test(path) || GENERATED_FILE.test(path);
}

export type PathDecision =
  | { include: true; contentIndexed: boolean }
  | { include: false; reason: 'excluded' | 'secret' };

export interface PathRules {
  decide(path: string): PathDecision;
}

export function createPathRules(config: IndexConfig): PathRules {
  const globs = config.exclude.map((pattern) => new Bun.Glob(pattern));
  return {
    decide(path) {
      if (isSecretFile(path)) return { include: false, reason: 'secret' };
      if (globs.some((glob) => glob.match(path))) return { include: false, reason: 'excluded' };
      return { include: true, contentIndexed: !isGeneratedPath(path) };
    },
  };
}

export function hasBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8000);
  for (let i = 0; i < limit; i++) if (bytes[i] === 0) return true;
  return false;
}

export function looksGenerated(text: string, lineCount: number): boolean {
  const head = text.slice(0, 600);
  if (/@generated|DO NOT EDIT|auto-generated|autogenerated/i.test(head)) return true;
  return lineCount > 0 && lineCount <= 5 && text.length / lineCount > 1000;
}
