import type { Database } from 'bun:sqlite';
import { all } from '@agent-rail/storage';
import { readText } from './content.ts';
import { basenameOf, dirnameOf, PACKAGE_MANIFESTS } from './rules.ts';

export type PackageKind = 'npm' | 'cargo' | 'python';

export interface PackageInfo {
  kind: PackageKind;
  name: string | null;
  root: string;
  manifestPath: string;
  entry: string | null;
  workspaceMembers: string[];
  scripts: Record<string, string>;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function joinPath(root: string, relative: string): string {
  const parts = root === '.' || root === '' ? [] : root.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function exportEntry(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const obj = asObject(value);
  if (!obj) return null;
  const dot = obj['.'];
  if (dot !== undefined) return exportEntry(dot);
  for (const key of ['bun', 'import', 'types', 'default', 'require', 'node']) {
    const found = exportEntry(obj[key]);
    if (found) return found;
  }
  return null;
}

function parseManifest(path: string, text: string): PackageInfo | null {
  const root = dirnameOf(path) || '.';
  const file = basenameOf(path);
  try {
    if (file === 'package.json') {
      const json = asObject(JSON.parse(text));
      if (!json) return null;
      const scripts: Record<string, string> = {};
      for (const [k, v] of Object.entries(asObject(json.scripts) ?? {})) if (typeof v === 'string') scripts[k] = v;
      const workspaces = Array.isArray(json.workspaces)
        ? asStrings(json.workspaces)
        : asStrings(asObject(json.workspaces)?.packages);
      const entry = exportEntry(json.exports) ?? asString(json.module) ?? asString(json.main) ?? asString(json.types);
      return {
        kind: 'npm',
        name: asString(json.name),
        root,
        manifestPath: path,
        entry: entry ? joinPath(root, entry) : null,
        workspaceMembers: workspaces,
        scripts,
      };
    }
    if (file === 'Cargo.toml') {
      const toml = asObject(Bun.TOML.parse(text));
      const pkg = asObject(toml?.package);
      const lib = asString(asObject(toml?.lib)?.path);
      return {
        kind: 'cargo',
        name: asString(pkg?.name),
        root,
        manifestPath: path,
        entry: joinPath(root, lib ?? 'src/lib.rs'),
        workspaceMembers: asStrings(asObject(toml?.workspace)?.members),
        scripts: {},
      };
    }
    if (file === 'pyproject.toml') {
      const toml = asObject(Bun.TOML.parse(text));
      const project = asObject(toml?.project);
      const poetry = asObject(asObject(toml?.tool)?.poetry);
      const scripts: Record<string, string> = {};
      for (const [k, v] of Object.entries(asObject(project?.scripts) ?? {})) if (typeof v === 'string') scripts[k] = v;
      return {
        kind: 'python',
        name: asString(project?.name) ?? asString(poetry?.name),
        root,
        manifestPath: path,
        entry: null,
        workspaceMembers: [],
        scripts,
      };
    }
  } catch {
    return {
      kind: file === 'package.json' ? 'npm' : file === 'Cargo.toml' ? 'cargo' : 'python',
      name: null,
      root,
      manifestPath: path,
      entry: null,
      workspaceMembers: [],
      scripts: {},
    };
  }
  return null;
}

export interface SnapshotFileRow {
  path: string;
  blob_sha: string;
  language: string | null;
  kind: string;
  package_root: string | null;
}

export function loadPackages(db: Database, files: readonly SnapshotFileRow[]): PackageInfo[] {
  const out: PackageInfo[] = [];
  for (const f of files) {
    if (!PACKAGE_MANIFESTS.has(basenameOf(f.path))) continue;
    const info = parseManifest(f.path, readText(db, f.blob_sha));
    if (info) out.push(info);
  }
  return out.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

export function snapshotFiles(db: Database, snapshotId: string): SnapshotFileRow[] {
  return all<SnapshotFileRow>(
    db,
    'SELECT path, blob_sha, language, kind, package_root FROM files WHERE snapshot_id = ? ORDER BY path',
    snapshotId,
  );
}

export type CommandKind = 'build' | 'test' | 'lint' | 'typecheck' | 'format';

export interface DiscoveredCommand {
  kind: CommandKind;
  command: string;
  cwd: string;
  source: string;
}

const SCRIPT_KINDS: Record<string, CommandKind> = {
  build: 'build',
  test: 'test',
  lint: 'lint',
  typecheck: 'typecheck',
  'type-check': 'typecheck',
  check: 'lint',
  format: 'format',
};

export function discoverCommands(
  db: Database,
  files: readonly SnapshotFileRow[],
  packages: readonly PackageInfo[],
): DiscoveredCommand[] {
  const paths = new Set(files.map((f) => f.path));
  const runner =
    paths.has('bun.lock') || paths.has('bun.lockb')
      ? 'bun run'
      : paths.has('pnpm-lock.yaml')
        ? 'pnpm run'
        : paths.has('yarn.lock')
          ? 'yarn'
          : 'npm run';
  const commands: DiscoveredCommand[] = [];
  const cargoWorkspaceRoots = new Set(
    packages.filter((p) => p.kind === 'cargo' && p.workspaceMembers.length > 0).map((p) => p.root),
  );
  for (const pkg of packages) {
    if (pkg.kind === 'npm') {
      for (const script of Object.keys(pkg.scripts)) {
        const kind = SCRIPT_KINDS[script];
        if (kind) commands.push({ kind, command: `${runner} ${script}`, cwd: pkg.root, source: pkg.manifestPath });
      }
    } else if (pkg.kind === 'cargo') {
      const insideWorkspace = [...cargoWorkspaceRoots].some(
        (root) => root !== pkg.root && (root === '.' || pkg.root.startsWith(`${root}/`)),
      );
      if (insideWorkspace) continue;
      commands.push({ kind: 'build', command: 'cargo build', cwd: pkg.root, source: pkg.manifestPath });
      commands.push({ kind: 'test', command: 'cargo test', cwd: pkg.root, source: pkg.manifestPath });
      commands.push({ kind: 'lint', command: 'cargo clippy', cwd: pkg.root, source: pkg.manifestPath });
    } else {
      const prefix = paths.has(joinPath(pkg.root, 'uv.lock'))
        ? 'uv run '
        : paths.has(joinPath(pkg.root, 'poetry.lock'))
          ? 'poetry run '
          : '';
      commands.push({ kind: 'test', command: `${prefix}pytest`, cwd: pkg.root, source: pkg.manifestPath });
    }
  }
  const makefile = files.find((f) => f.path === 'Makefile');
  if (makefile) {
    for (const line of readText(db, makefile.blob_sha).split('\n')) {
      const target = /^([A-Za-z][\w-]*)\s*:(?!=)/.exec(line)?.[1];
      const kind = target ? SCRIPT_KINDS[target] : undefined;
      if (target && kind) commands.push({ kind, command: `make ${target}`, cwd: '.', source: 'Makefile' });
    }
  }
  return commands;
}
