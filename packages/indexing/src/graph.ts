import type { Database } from 'bun:sqlite';
import { fingerprint } from '@crewyard/core';
import type { CrewContext, Store } from '@crewyard/storage';
import { all } from '@crewyard/storage';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import { joinPath, loadPackages, type PackageInfo, type SnapshotFileRow, snapshotFiles } from './manifests.ts';
import { basenameOf, dirnameOf } from './rules.ts';
import type { Provenance, ResultEnvelope, Snapshot } from './types.ts';

export interface ImportLink {
  from: string;
  to: string | null;
  specifier: string;
  line: number | null;
  names: string[];
  resolution: 'syntax' | 'file';
}

export interface SnapshotModel {
  snapshot: Snapshot;
  files: SnapshotFileRow[];
  byPath: Map<string, SnapshotFileRow>;
  packages: PackageInfo[];
  imports: Map<string, ImportLink[]>;
  importedBy: Map<string, ImportLink[]>;
}

const CACHE_LIMIT = 4;
const cache = new Map<string, SnapshotModel>();

const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

class Resolver {
  private readonly cargoBySrc: Map<string, string>;
  private readonly crates: Map<string, string>;
  private readonly npm: PackageInfo[];
  private readonly pythonRoots: string[];

  constructor(
    private readonly paths: Map<string, SnapshotFileRow>,
    packages: readonly PackageInfo[],
  ) {
    this.npm = packages.filter((p) => p.kind === 'npm' && p.name).sort((a, b) => b.name!.length - a.name!.length);
    this.crates = new Map();
    this.cargoBySrc = new Map();
    for (const p of packages) {
      if (p.kind !== 'cargo') continue;
      const src = dirnameOf(p.entry ?? joinPath(p.root, 'src/lib.rs'));
      if (p.name) this.crates.set(p.name.replaceAll('-', '_'), src);
      this.cargoBySrc.set(p.root, src);
    }
    const roots = new Set(['', 'src']);
    for (const p of packages) {
      if (p.kind !== 'python') continue;
      roots.add(p.root === '.' ? '' : p.root);
      roots.add(joinPath(p.root, 'src'));
    }
    this.pythonRoots = [...roots];
  }

  private first(candidates: Iterable<string>): string | null {
    for (const c of candidates) if (this.paths.has(c)) return c;
    return null;
  }

  private *tsCandidates(base: string): Generator<string> {
    yield base;
    for (const [ext, replacements] of Object.entries(JS_TO_TS)) {
      if (base.endsWith(ext)) for (const r of replacements) yield base.slice(0, -ext.length) + r;
    }
    for (const ext of TS_EXTENSIONS) yield base + ext;
    for (const ext of TS_EXTENSIONS) yield `${base}/index${ext}`;
  }

  resolve(
    from: string,
    language: string | null,
    specifier: string,
    name: string | null,
    resolution: string,
  ): string | null {
    if (resolution === 'file') return this.resolveFileLink(from, specifier);
    if (language === 'typescript' || language === 'javascript') return this.resolveTs(from, specifier);
    if (language === 'python') return this.resolvePython(from, specifier, name);
    if (language === 'rust') return this.resolveRust(from, specifier);
    return null;
  }

  private resolveFileLink(from: string, target: string): string | null {
    const base = target.startsWith('/') ? joinPath('', target) : joinPath(dirnameOf(from), target);
    return this.first([base, `${base}/README.md`, `${base}/index.md`]);
  }

  private resolveTs(from: string, spec: string): string | null {
    if (spec.startsWith('.')) return this.first(this.tsCandidates(joinPath(dirnameOf(from), spec)));
    for (const pkg of this.npm) {
      if (spec === pkg.name) {
        return this.first([
          ...(pkg.entry ? this.tsCandidates(pkg.entry) : []),
          ...this.tsCandidates(joinPath(pkg.root, 'src/index')),
          ...this.tsCandidates(joinPath(pkg.root, 'index')),
        ]);
      }
      if (spec.startsWith(`${pkg.name}/`)) {
        const sub = spec.slice(pkg.name!.length + 1);
        return this.first([
          ...this.tsCandidates(joinPath(pkg.root, sub)),
          ...this.tsCandidates(joinPath(pkg.root, `src/${sub}`)),
        ]);
      }
    }
    return null;
  }

  private resolvePython(from: string, spec: string, name: string | null): string | null {
    const dots = /^\.*/.exec(spec)![0].length;
    const modulePath = spec.slice(dots).replaceAll('.', '/');
    const bases: string[] = [];
    if (dots > 0) {
      let dir = dirnameOf(from);
      for (let i = 1; i < dots; i++) dir = dirnameOf(dir);
      bases.push(joinPath(dir, modulePath));
    } else {
      for (const root of this.pythonRoots) bases.push(joinPath(root, modulePath));
    }
    const candidates: string[] = [];
    for (const base of bases) {
      if (name && name !== '*') candidates.push(joinPath(base, `${name}.py`), joinPath(base, `${name}/__init__.py`));
      if (base !== '') candidates.push(`${base}.py`, `${base}.pyi`);
      candidates.push(joinPath(base, '__init__.py'));
    }
    return this.first(candidates);
  }

  private moduleDir(file: string): string {
    const base = basenameOf(file);
    const dir = dirnameOf(file);
    if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') return dir;
    return joinPath(dir, base.replace(/\.rs$/, ''));
  }

  private crateRoot(file: string): string | null {
    const pkgRoot = this.paths.get(file)?.package_root;
    if (pkgRoot && this.cargoBySrc.has(pkgRoot)) return this.cargoBySrc.get(pkgRoot)!;
    let dir = dirnameOf(file);
    for (;;) {
      if (this.paths.has(joinPath(dir, 'lib.rs')) || this.paths.has(joinPath(dir, 'main.rs'))) return dir;
      if (dir === '') return null;
      dir = dirnameOf(dir);
    }
  }

  private resolveRust(from: string, spec: string): string | null {
    const segments = spec.split('::').filter(Boolean);
    let dir: string | null;
    let rest: string[];
    const head = segments[0];
    if (head === 'crate') {
      dir = this.crateRoot(from);
      rest = segments.slice(1);
    } else if (head === 'self' || head === 'super') {
      dir = this.moduleDir(from);
      let i = 0;
      if (head === 'self') i = 1;
      while (segments[i] === 'super') {
        dir = dirnameOf(dir);
        i++;
      }
      rest = segments.slice(i);
    } else if (head && this.crates.has(head)) {
      dir = this.crates.get(head)!;
      rest = segments.slice(1);
    } else {
      return null;
    }
    if (dir === null) return null;
    for (let k = rest.length; k >= 0; k--) {
      const modulePath = joinPath(dir, rest.slice(0, k).join('/'));
      const found =
        k === 0
          ? this.first([
              `${modulePath}.rs`,
              joinPath(modulePath, 'mod.rs'),
              joinPath(modulePath, 'lib.rs'),
              joinPath(modulePath, 'main.rs'),
            ])
          : this.first([`${modulePath}.rs`, joinPath(modulePath, 'mod.rs')]);
      if (found && found !== from) return found;
    }
    return null;
  }
}

interface EdgeRow {
  path: string;
  language: string | null;
  target: string;
  source_symbol: string | null;
  line: number | null;
  resolution: 'syntax' | 'file';
}

function buildModel(db: Database, snapshot: Snapshot): SnapshotModel {
  const files = snapshotFiles(db, snapshot.id);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const packages = loadPackages(db, files);
  const resolver = new Resolver(byPath, packages);
  const rows = all<EdgeRow>(
    db,
    `SELECT f.path, f.language, e.target, e.source_symbol, e.line, e.resolution
     FROM files f JOIN symbol_edges e ON e.blob_sha = f.blob_sha
     WHERE f.snapshot_id = ? AND (e.kind = 'import' OR (e.kind = 'reference' AND e.resolution = 'file'))
     ORDER BY f.path, e.line`,
    snapshot.id,
  );
  const imports = new Map<string, ImportLink[]>();
  const importedBy = new Map<string, ImportLink[]>();
  const grouped = new Map<string, ImportLink>();
  for (const row of rows) {
    const to = resolver.resolve(row.path, row.language, row.target, row.source_symbol, row.resolution);
    const key = `${row.path}\0${to ?? row.target}`;
    const existing = grouped.get(key);
    if (existing) {
      if (row.source_symbol && !existing.names.includes(row.source_symbol)) existing.names.push(row.source_symbol);
      continue;
    }
    const link: ImportLink = {
      from: row.path,
      to,
      specifier: row.target,
      line: row.line,
      names: row.source_symbol ? [row.source_symbol] : [],
      resolution: row.resolution,
    };
    grouped.set(key, link);
    push(imports, row.path, link);
    if (to) push(importedBy, to, link);
  }
  return { snapshot, files, byPath, packages, imports, importedBy };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function snapshotModel(store: Store, snapshot: Snapshot): SnapshotModel {
  const key = `${store.path}\0${snapshot.id}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const model = buildModel(store.db, snapshot);
  cache.set(key, model);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return model;
}

export function forgetSnapshotModels(snapshotIds: readonly string[]): void {
  const ids = new Set(snapshotIds);
  for (const [key, model] of cache) if (ids.has(model.snapshot.id)) cache.delete(key);
}

export type GraphDirection = 'imports' | 'importedBy' | 'both';

export interface DependencyGraphInput extends SnapshotRequest {
  paths: string[];
  direction?: GraphDirection;
  depth?: number;
  limit?: number;
}

export interface GraphNode {
  path: string;
  depth: number;
  packageRoot: string | null;
  kind: string | null;
}

export interface GraphEdge {
  from: string;
  to: string | null;
  specifier: string;
  names: string[];
  resolution: 'syntax' | 'file';
  provenance: Provenance;
}

export interface DependencyGraphResult extends ResultEnvelope {
  roots: string[];
  direction: GraphDirection;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  note: string;
  contentFingerprint: string;
  revision: string | null;
  coverage: {
    depth: number;
    limit: number;
    missingPaths: string[];
    unresolvedImports: string[];
    incompletePaths: string[];
  };
}

export const SYNTAX_NOTE =
  'Edges come from syntax-level import analysis (tree-sitter); dynamic imports, path aliases and macro-generated modules may be missing. This is not a complete semantic dependency graph.';

export function traverse(
  model: SnapshotModel,
  roots: readonly string[],
  direction: GraphDirection,
  depth: number,
  limit: number,
): { depths: Map<string, number>; links: ImportLink[]; truncated: boolean } {
  const depths = new Map<string, number>();
  const links: ImportLink[] = [];
  const seenLinks = new Set<ImportLink>();
  const knownRoots = [...new Set(roots)].filter((p) => model.byPath.has(p));
  let frontier = knownRoots.slice(0, Math.max(0, limit));
  for (const root of frontier) depths.set(root, 0);
  let truncated = knownRoots.length > frontier.length;
  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const path of frontier) {
      const outgoing = direction === 'importedBy' ? [] : (model.imports.get(path) ?? []);
      const incoming = direction === 'imports' ? [] : (model.importedBy.get(path) ?? []);
      for (const link of [...outgoing, ...incoming]) {
        if (!seenLinks.has(link)) {
          seenLinks.add(link);
          links.push(link);
        }
        const neighbour = link.from === path ? link.to : link.from;
        if (neighbour === null || depths.has(neighbour)) continue;
        if (depths.size >= limit) {
          truncated = true;
          continue;
        }
        depths.set(neighbour, level);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  for (const path of frontier) {
    const outgoing = direction === 'importedBy' ? [] : (model.imports.get(path) ?? []);
    const incoming = direction === 'imports' ? [] : (model.importedBy.get(path) ?? []);
    if (
      [...outgoing, ...incoming].some((link) => {
        const neighbour = link.from === path ? link.to : link.from;
        return neighbour === null || !depths.has(neighbour);
      })
    )
      truncated = true;
  }
  return { depths, links, truncated };
}

export async function dependencyGraph(ctx: CrewContext, input: DependencyGraphInput): Promise<DependencyGraphResult> {
  const { snapshot, envelope } = await requireSnapshot(ctx, input);
  const model = snapshotModel(ctx.store, snapshot);
  const direction = input.direction ?? 'both';
  const depth = Math.min(Math.max(input.depth ?? 1, 0), 10);
  const limit = Math.max(input.limit ?? 500, 0);
  const { depths, links, truncated } = traverse(model, input.paths, direction, depth, limit);
  const nodes = [...depths].map(([path, depth]) => {
    const file = model.byPath.get(path);
    return { path, depth, packageRoot: file?.package_root ?? null, kind: file?.kind ?? null };
  });
  const edges = links
    .filter((l) => depths.has(l.from) && (l.to === null || depths.has(l.to)))
    .map((l) => ({
      from: l.from,
      to: l.to,
      specifier: l.specifier,
      names: l.names,
      resolution: l.resolution,
      provenance: {
        repositoryId: envelope.repositoryId,
        commitSha: envelope.commitSha,
        path: l.from,
        startLine: l.line ?? 1,
        endLine: l.line ?? 1,
        blobSha: model.byPath.get(l.from)!.blob_sha,
        retrievedAt: envelope.retrievedAt,
        indexStatus: envelope.indexStatus,
      },
    }));
  const contents = all<{ path: string; blob_sha: string; parse_status: string; parser: string | null }>(
    ctx.store.db,
    'SELECT f.path, f.blob_sha, b.parse_status, b.parser FROM files f LEFT JOIN blobs b ON b.sha = f.blob_sha WHERE f.snapshot_id = ? ORDER BY f.path',
    snapshot.id,
  ).filter((file) => depths.has(file.path));
  const coverage = {
    depth,
    limit,
    missingPaths: [...new Set(input.paths.filter((path) => !model.byPath.has(path)))].sort(),
    unresolvedImports: [
      ...new Set(links.filter((link) => link.to === null).map((link) => `${link.from}:${link.specifier}`)),
    ].sort(),
    incompletePaths: contents
      .filter((file) => file.parse_status !== 'parsed' && file.parse_status !== 'text')
      .map((file) => file.path),
  };
  const contentFingerprint = fingerprint({
    revision: snapshot.revision,
    contents,
    links,
    coverage,
    truncated,
    direction,
  });
  return {
    ...envelope,
    roots: input.paths,
    direction,
    nodes,
    edges,
    truncated,
    note: SYNTAX_NOTE,
    contentFingerprint,
    revision: snapshot.revision,
    coverage,
  };
}
