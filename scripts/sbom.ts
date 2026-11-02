import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

type DependencyMap = Record<string, string>;

interface PackageInfo {
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  os?: string | string[];
  cpu?: string | string[];
}

interface WorkspaceEntry extends PackageInfo {
  name?: string;
  version?: string;
  devDependencies?: DependencyMap;
}

export interface BunLockfile {
  lockfileVersion: number;
  workspaces: Record<string, WorkspaceEntry>;
  packages: Record<string, unknown[]>;
}

interface LockPackage {
  key: string;
  name: string;
  version: string;
  workspacePath: string | null;
  info: PackageInfo;
  integrity: string | null;
}

interface CdxComponent {
  type: 'library' | 'application';
  'bom-ref': string;
  name: string;
  group?: string;
  version: string;
  scope: 'required' | 'excluded';
  purl?: string;
  hashes?: { alg: 'SHA-512' | 'SHA-256' | 'SHA-1'; content: string }[];
  properties?: { name: string; value: string }[];
}

export function parseBunLock(text: string): BunLockfile {
  const lock = Bun.JSONC.parse(text) as BunLockfile;
  if (typeof lock?.lockfileVersion !== 'number' || !lock.workspaces || !lock.packages) {
    throw new Error('Not a Bun text lockfile (bun.lock)');
  }
  if (lock.lockfileVersion > 2) throw new Error(`Unsupported bun.lock version ${lock.lockfileVersion}`);
  return lock;
}

function splitIdent(ident: string): { name: string; spec: string } {
  const at = ident.indexOf('@', 1);
  return { name: ident.slice(0, at), spec: ident.slice(at + 1) };
}

function toPackages(lock: BunLockfile): Map<string, LockPackage> {
  const out = new Map<string, LockPackage>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const ident = String(entry[0]);
    const { name, spec } = splitIdent(ident);
    if (spec.startsWith('workspace:')) {
      const path = spec.slice('workspace:'.length);
      const ws = lock.workspaces[path] ?? {};
      out.set(key, { key, name, version: ws.version ?? '0.0.0', workspacePath: path, info: ws, integrity: null });
      continue;
    }
    const info = (entry.find((v, i) => i > 0 && v !== null && typeof v === 'object') ?? {}) as PackageInfo;
    const last = entry.at(-1);
    const integrity = typeof last === 'string' && /^sha(512|256|1)-/.test(last) ? last : null;
    out.set(key, { key, name, version: spec, workspacePath: null, info, integrity });
  }
  return out;
}

function resolveKey(packages: Map<string, LockPackage>, fromKey: string | null, dep: string): string | null {
  if (fromKey) {
    const parts = fromKey.split('/');
    for (let i = parts.length; i > 0; i--) {
      const candidate = `${parts.slice(0, i).join('/')}/${dep}`;
      if (packages.has(candidate)) return candidate;
    }
  }
  return packages.has(dep) ? dep : null;
}

function purl(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

function hashOf(integrity: string | null): CdxComponent['hashes'] {
  if (!integrity) return undefined;
  const [alg, b64] = [integrity.slice(0, integrity.indexOf('-')), integrity.slice(integrity.indexOf('-') + 1)];
  const map = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' } as const;
  const cdxAlg = map[alg as keyof typeof map];
  return cdxAlg ? [{ alg: cdxAlg, content: Buffer.from(b64, 'base64').toString('hex') }] : undefined;
}

function deps(info: PackageInfo): string[] {
  return [
    ...Object.keys(info.dependencies ?? {}),
    ...Object.keys(info.optionalDependencies ?? {}),
    ...Object.keys(info.peerDependencies ?? {}),
  ];
}

export function generateSbom(
  lock: BunLockfile,
  options: { serialNumber?: string; timestamp?: string } = {},
): Record<string, unknown> {
  const root = lock.workspaces[''] ?? {};
  const rootName = root.name ?? 'root';
  const rootVersion = root.version ?? '0.0.0';
  const packages = toPackages(lock);
  const refOf = (pkg: LockPackage) =>
    pkg.workspacePath === null ? `${purl(pkg.name, pkg.version)}#${pkg.key}` : `workspace:${pkg.workspacePath}`;

  const graph = new Map<string, Set<string>>();
  const edges = (key: string | null, names: string[]) =>
    names.map((name) => resolveKey(packages, key, name)).filter((k): k is string => k !== null);
  for (const pkg of packages.values()) graph.set(pkg.key, new Set(edges(pkg.key, deps(pkg.info))));

  const runtimeRoots = [
    ...edges(null, deps(root)),
    ...Object.entries(lock.workspaces)
      .filter(([path]) => path !== '')
      .flatMap(([, ws]) => edges(ws.name ?? null, deps(ws))),
  ];
  const runtime = new Set<string>();
  const stack = [...runtimeRoots];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (runtime.has(key)) continue;
    runtime.add(key);
    stack.push(...(graph.get(key) ?? []));
  }

  const components: CdxComponent[] = [...packages.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((pkg) => {
      const scoped = pkg.name.startsWith('@');
      const group = scoped ? pkg.name.slice(0, pkg.name.indexOf('/')) : undefined;
      const properties = [
        ...(pkg.workspacePath === null ? [] : [{ name: 'agent-rail:workspace', value: pkg.workspacePath }]),
        ...(pkg.key === pkg.name ? [] : [{ name: 'agent-rail:lockfile-key', value: pkg.key }]),
        ...(runtime.has(pkg.key) ? [] : [{ name: 'cdx:npm:package:development', value: 'true' }]),
      ];
      const hashes = hashOf(pkg.integrity);
      return {
        type: 'library',
        'bom-ref': refOf(pkg),
        name: scoped ? pkg.name.slice(pkg.name.indexOf('/') + 1) : pkg.name,
        ...(group ? { group } : {}),
        version: pkg.version,
        scope: runtime.has(pkg.key) ? 'required' : 'excluded',
        ...(pkg.workspacePath === null ? { purl: purl(pkg.name, pkg.version) } : {}),
        ...(hashes ? { hashes } : {}),
        ...(properties.length > 0 ? { properties } : {}),
      };
    });

  const rootRef = `${purl(rootName, rootVersion)}#root`;
  const byKey = new Map([...packages.values()].map((pkg) => [pkg.key, refOf(pkg)]));
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: [...new Set(edges(null, [...deps(root), ...Object.keys(root.devDependencies ?? {})]))].map(
        (k) => byKey.get(k)!,
      ),
    },
    ...[...packages.values()].map((pkg) => ({
      ref: refOf(pkg),
      dependsOn: [...(graph.get(pkg.key) ?? [])].map((k) => byKey.get(k)!).sort(),
    })),
  ];

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: options.serialNumber ?? `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: options.timestamp ?? new Date().toISOString(),
      lifecycles: [{ phase: 'build' }],
      tools: { components: [{ type: 'application', name: 'agent-rail scripts/sbom.ts', version: rootVersion }] },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: rootName,
        version: rootVersion,
        purl: purl(rootName, rootVersion),
      },
    },
    components,
    dependencies,
  };
}

if (import.meta.main) {
  const ROOT = resolve(import.meta.dir, '..');
  const { values } = parseArgs({
    options: {
      lockfile: { type: 'string', default: join(ROOT, 'bun.lock') },
      out: { type: 'string', default: join(ROOT, 'dist', 'sbom.cdx.json') },
    },
  });
  const lock = parseBunLock(await Bun.file(values.lockfile).text());
  const sourceDate = Bun.spawnSync(['git', 'log', '-1', '--format=%cI'], { cwd: ROOT, stdout: 'pipe' });
  const timestamp = sourceDate.exitCode === 0 ? new Date(sourceDate.stdout.toString().trim()).toISOString() : undefined;
  const bom = generateSbom(lock, timestamp ? { timestamp } : {});
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(bom, null, 2)}\n`);
  console.log(`Wrote ${values.out} (${(bom.components as unknown[]).length} components)`);
}
