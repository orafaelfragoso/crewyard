import type { ConfidenceTier } from '@crewyard/core';
import { fingerprint, newId, nowIso } from '@crewyard/core';
import {
  findSymbol,
  isTestPath,
  type ResultEnvelope,
  requireSnapshot,
  type SnapshotModel,
  type SnapshotRequest,
  SYNTAX_NOTE,
  snapshotModel,
  traverse,
} from '@crewyard/indexing';
import { all, type CrewContext, parseJson } from '@crewyard/storage';

export const IMPACT_DISCLAIMER =
  'Impact analysis is derived from syntax-level imports, symbol names and naming conventions at this commit. ' +
  "Items marked 'heuristic' are predictions, and the absence of an item never proves the absence of a conflict; " +
  'integration validation is still required.';

export interface ImpactInput extends SnapshotRequest {
  paths?: string[];
  symbols?: string[];
  depth?: number;
  excludeTaskId?: string;
  persist?: boolean;
}

export interface ChangedFile {
  path: string;
  packageRoot: string | null;
  tier: ConfidenceTier;
  reason: string;
}

export interface TouchedModule {
  module: string;
  kind: 'package' | 'directory';
  name: string | null;
  tier: ConfidenceTier;
  reason: string;
}

export interface Dependent {
  path: string;
  depth: number;
  tier: ConfidenceTier;
  reason: string;
}

export interface RelatedTest {
  path: string;
  tier: ConfidenceTier;
  reason: string;
}

export interface LeasedScopeOverlap {
  reservationId: string;
  taskId: string;
  scope: string;
  mode: 'advisory' | 'exclusive';
  matchedPaths: string[];
  tier: ConfidenceTier;
  reason: string;
}

export interface PullRequestOverlap {
  prId: string;
  number: number;
  title: string;
  headRef: string;
  overlappingPaths: string[];
  tier: ConfidenceTier;
  reason: string;
}

export interface ImpactReport extends ResultEnvelope {
  reportId: string | null;
  changedFiles: ChangedFile[];
  unknownPaths: string[];
  modules: TouchedModule[];
  dependents: Dependent[];
  relatedTests: RelatedTest[];
  leasedScopes: LeasedScopeOverlap[];
  openPullRequests: PullRequestOverlap[];
  disclaimer: string;
  note: string;
}

const TIER_ORDER: Record<ConfidenceTier, number> = { exact: 0, structural: 1, heuristic: 2 };

function _better(a: ConfidenceTier, b: ConfidenceTier): ConfidenceTier {
  return TIER_ORDER[a] <= TIER_ORDER[b] ? a : b;
}

const RESOURCE_SCOPE = /^[a-z][a-z0-9_-]*:/i;
const GLOB_CHARS = /[*?[\]{}]/;

export function scopeMatchesPath(scope: string, path: string): boolean {
  const trimmed = scope.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (trimmed === '' || RESOURCE_SCOPE.test(trimmed)) return false;
  if (GLOB_CHARS.test(trimmed) && new Bun.Glob(trimmed).match(path)) return true;
  const prefix: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (GLOB_CHARS.test(segment)) break;
    prefix.push(segment);
  }
  const base = prefix.join('/');
  return base === '' || path === base || path.startsWith(`${base}/`);
}

function testStem(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const match =
    /^(.+?)\.(test|spec)\.[cm]?[jt]sx?$/.exec(base) ??
    /^test_(.+)\.py$/.exec(base) ??
    /^(.+)_test\.(py|go|rs)$/.exec(base) ??
    /^(.+)\.(?:[cm]?[jt]sx?|py|rs)$/.exec(base);
  return match?.[1] ?? null;
}

function sourceStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem === 'index' || stem === '__init__' || stem === 'mod' || stem === 'lib') {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
    return dir.slice(dir.lastIndexOf('/') + 1) || stem;
  }
  return stem;
}

function topDirectory(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

function changedPathsOf(value: string | null): string[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const path = record.path ?? record.filename;
      if (typeof path === 'string') out.push(path);
      if (typeof record.previous_filename === 'string') out.push(record.previous_filename);
    }
  }
  return out;
}

function modulesFor(model: SnapshotModel, changed: readonly ChangedFile[]): TouchedModule[] {
  const modules = new Map<string, TouchedModule>();
  for (const file of changed) {
    if (file.packageRoot !== null) {
      const pkg = model.packages.find((p) => p.root === file.packageRoot);
      const key = `package:${file.packageRoot}`;
      if (!modules.has(key)) {
        modules.set(key, {
          module: file.packageRoot,
          kind: 'package',
          name: pkg?.name ?? null,
          tier: file.tier,
          reason: `contains ${file.path}`,
        });
      }
    }
    const dir = topDirectory(file.path);
    const key = `dir:${dir}`;
    if (!modules.has(key))
      modules.set(key, {
        module: dir,
        kind: 'directory',
        name: null,
        tier: file.tier,
        reason: `contains ${file.path}`,
      });
  }
  return [...modules.values()];
}

export async function analyzeImpact(ctx: CrewContext, input: ImpactInput): Promise<ImpactReport> {
  const { repo, snapshot, envelope } = await requireSnapshot(ctx, input);
  const model = snapshotModel(ctx.store, snapshot);
  const changed = new Map<string, ChangedFile>();
  const unknownPaths: string[] = [];
  const heuristicSeeds = new Map<string, string>();

  for (const raw of input.paths ?? []) {
    const path = raw.replace(/^\.\//, '');
    const file = model.byPath.get(path);
    if (file) changed.set(path, { path, packageRoot: file.package_root, tier: 'exact', reason: 'listed as changed' });
    else unknownPaths.push(path);
  }
  for (const symbol of input.symbols ?? []) {
    const defs = await findSymbol(ctx, { repositoryId: repo.id, sha: snapshot.commitSha, name: symbol, limit: 20 });
    for (const def of defs.definitions) {
      if (!changed.has(def.path)) {
        changed.set(def.path, {
          path: def.path,
          packageRoot: def.packageRoot,
          tier: 'exact',
          reason: `defines ${symbol}`,
        });
      }
    }
    const refs = all<{ path: string }>(
      ctx.store.db,
      `SELECT DISTINCT f.path FROM symbol_edges e JOIN files f ON f.blob_sha = e.blob_sha AND f.snapshot_id = ?
       WHERE e.target = ? AND e.kind IN ('call', 'reference') LIMIT 500`,
      snapshot.id,
      symbol.split(/::|\.|#/).pop() ?? symbol,
    );
    for (const ref of refs)
      if (!heuristicSeeds.has(ref.path)) heuristicSeeds.set(ref.path, `mentions symbol ${symbol}`);
  }

  const changedFiles = [...changed.values()];
  const roots = changedFiles.map((c) => c.path);
  const depth = Math.min(Math.max(input.depth ?? 2, 1), 6);
  const { depths } = traverse(model, roots, 'importedBy', depth, 2_000);
  const dependents = new Map<string, Dependent>();
  for (const [path, d] of depths) {
    if (d === 0) continue;
    const via = (model.imports.get(path) ?? []).find((l) => l.to !== null && depths.get(l.to) === d - 1)?.to;
    dependents.set(path, {
      path,
      depth: d,
      tier: 'structural',
      reason:
        d === 1
          ? `imports ${via ?? 'a changed file'}`
          : `transitively imports a changed file via ${via ?? 'a dependent'} (depth ${d})`,
    });
  }
  for (const [path, reason] of heuristicSeeds) {
    if (!changed.has(path) && !dependents.has(path))
      dependents.set(path, { path, depth: 1, tier: 'heuristic', reason });
  }

  const tests = new Map<string, RelatedTest>();
  const addTest = (path: string, tier: ConfidenceTier, reason: string) => {
    const existing = tests.get(path);
    if (!existing || TIER_ORDER[tier] < TIER_ORDER[existing.tier]) tests.set(path, { path, tier, reason });
  };
  for (const c of changedFiles) if (isTestPath(c.path)) addTest(c.path, 'exact', 'test file is itself changed');
  for (const d of dependents.values()) {
    if (isTestPath(d.path)) addTest(d.path, d.tier === 'structural' ? 'structural' : 'heuristic', d.reason);
  }
  const stems = new Map<string, string>();
  for (const c of changedFiles) if (!isTestPath(c.path)) stems.set(sourceStem(c.path).toLowerCase(), c.path);
  if (stems.size > 0) {
    for (const file of model.files) {
      if (file.kind !== 'test') continue;
      const stem = testStem(file.path)?.toLowerCase();
      const source = stem ? stems.get(stem) : undefined;
      if (source) addTest(file.path, 'heuristic', `test naming convention matches ${source}`);
    }
  }

  const changedSet = new Set(roots);
  const dependentPaths = [...dependents.values()].filter((d) => d.tier === 'structural').map((d) => d.path);

  const reservations = all<{ id: string; task_id: string; scope: string; mode: 'advisory' | 'exclusive' }>(
    ctx.store.db,
    `SELECT id, task_id, scope, mode FROM task_scope_reservations
     WHERE released_at IS NULL AND project_id = ? AND (repository_id IS NULL OR repository_id = ?)`,
    repo.projectId,
    repo.id,
  ).filter((r) => r.task_id !== input.excludeTaskId);
  const leasedScopes: LeasedScopeOverlap[] = [];
  for (const r of reservations) {
    const direct = roots.filter((p) => scopeMatchesPath(r.scope, p));
    const indirect = direct.length > 0 ? [] : dependentPaths.filter((p) => scopeMatchesPath(r.scope, p));
    if (direct.length === 0 && indirect.length === 0) continue;
    leasedScopes.push({
      reservationId: r.id,
      taskId: r.task_id,
      scope: r.scope,
      mode: r.mode,
      matchedPaths: direct.length > 0 ? direct : indirect,
      tier: direct.length > 0 ? 'exact' : 'structural',
      reason:
        direct.length > 0
          ? 'reserved scope contains a changed file'
          : 'reserved scope contains a dependent of a changed file',
    });
  }

  const changedPackages = new Set(changedFiles.map((c) => c.packageRoot).filter((p): p is string => p !== null));
  const prs = all<{ id: string; number: number; title: string; head_ref: string; changed_files: string | null }>(
    ctx.store.db,
    "SELECT id, number, title, head_ref, changed_files FROM pull_requests WHERE repository_id = ? AND state = 'open' ORDER BY number",
    repo.id,
  );
  const openPullRequests: PullRequestOverlap[] = [];
  for (const pr of prs) {
    const files = changedPathsOf(pr.changed_files);
    const direct = files.filter((p) => changedSet.has(p));
    const viaDeps = files.filter((p) => dependents.get(p)?.tier === 'structural');
    const samePackage = files.filter((p) => {
      const root = model.byPath.get(p)?.package_root;
      return root != null && changedPackages.has(root);
    });
    let tier: ConfidenceTier | null = null;
    let paths: string[] = [];
    let reason = '';
    if (direct.length > 0) [tier, paths, reason] = ['exact', direct, 'pull request changes the same files'];
    else if (viaDeps.length > 0)
      [tier, paths, reason] = ['structural', viaDeps, 'pull request changes files that import the changed files'];
    else if (samePackage.length > 0)
      [tier, paths, reason] = ['heuristic', samePackage, 'pull request changes files in the same package'];
    if (tier)
      openPullRequests.push({
        prId: pr.id,
        number: pr.number,
        title: pr.title,
        headRef: pr.head_ref,
        overlappingPaths: paths,
        tier,
        reason,
      });
  }

  const report: ImpactReport = {
    ...envelope,
    reportId: null,
    changedFiles,
    unknownPaths,
    modules: modulesFor(model, changedFiles),
    dependents: [...dependents.values()].sort(
      (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.depth - b.depth || a.path.localeCompare(b.path),
    ),
    relatedTests: [...tests.values()].sort(
      (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.path.localeCompare(b.path),
    ),
    leasedScopes,
    openPullRequests,
    disclaimer: IMPACT_DISCLAIMER,
    note: SYNTAX_NOTE,
  };
  if (input.persist ?? true) {
    const id = newId('ctx');
    const at = nowIso(ctx.clock);
    report.reportId = id;
    ctx.store.immediate((db) =>
      db
        .query(
          `INSERT INTO context_artifacts (id, kind, repository_id, snapshot_id, commit_sha, query, payload, token_estimate, created_at)
           VALUES (?, 'impact_report', ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          id,
          repo.id,
          snapshot.id,
          snapshot.commitSha,
          JSON.stringify({ paths: input.paths ?? [], symbols: input.symbols ?? [] }),
          JSON.stringify(report),
          at,
        ),
    );
  }
  return report;
}

export interface InterfaceFingerprintInput extends SnapshotRequest {
  paths: string[];
}

export interface FileInterface {
  path: string;
  basis: 'exported-symbols' | 'content' | 'missing';
  fingerprint: string;
  exportedSymbols: number;
}

export interface InterfaceFingerprint extends ResultEnvelope {
  fingerprint: string;
  files: FileInterface[];
}

export async function interfaceFingerprint(
  ctx: CrewContext,
  input: InterfaceFingerprintInput,
): Promise<InterfaceFingerprint> {
  const { snapshot, envelope } = await requireSnapshot(ctx, input);
  const model = snapshotModel(ctx.store, snapshot);
  const files: FileInterface[] = [];
  for (const path of [...new Set(input.paths)].sort()) {
    const file = model.byPath.get(path);
    if (!file) {
      files.push({ path, basis: 'missing', fingerprint: fingerprint({ path, missing: true }), exportedSymbols: 0 });
      continue;
    }
    const blob = all<{ parse_status: string; parser: string | null }>(
      ctx.store.db,
      'SELECT parse_status, parser FROM blobs WHERE sha = ?',
      file.blob_sha,
    )[0];
    const parsed = blob?.parser?.startsWith('tree-sitter') && blob.parse_status !== 'error';
    if (!parsed) {
      files.push({
        path,
        basis: 'content',
        fingerprint: fingerprint({ path, blob: file.blob_sha }),
        exportedSymbols: 0,
      });
      continue;
    }
    const symbols = all<{ name: string; kind: string; container: string | null; signature: string | null }>(
      ctx.store.db,
      `SELECT name, kind, container, signature FROM symbols WHERE blob_sha = ? AND exported = 1
       ORDER BY name, kind, COALESCE(container, ''), COALESCE(signature, '')`,
      file.blob_sha,
    );
    files.push({
      path,
      basis: 'exported-symbols',
      fingerprint: fingerprint({ path, symbols }),
      exportedSymbols: symbols.length,
    });
  }
  return { ...envelope, fingerprint: fingerprint(files.map((f) => [f.path, f.fingerprint])), files };
}
