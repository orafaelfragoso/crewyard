import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256File, writeChecksums } from './checksums.ts';

const ROOT = resolve(import.meta.dir, '..');
const ENTRY = join(ROOT, 'apps', 'cli', 'src', 'main.ts');

export const RELEASE_TARGETS = [
  { target: 'bun-linux-x64', os: 'linux', arch: 'x64' },
  { target: 'bun-linux-arm64', os: 'linux', arch: 'arm64' },
  { target: 'bun-darwin-arm64', os: 'darwin', arch: 'arm64' },
  { target: 'bun-darwin-x64', os: 'darwin', arch: 'x64' },
  { target: 'bun-windows-x64', os: 'windows', arch: 'x64' },
] as const;

type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export const BUN_RUNTIME_ALTERNATIVE =
  'Run from a source checkout with the Bun runtime instead (Bun >= 1.4.4); see docs/installation.md.';

type Artifact =
  | { target: string; os: string; arch: string; status: 'available'; file: string; size: number; sha256: string }
  | { target: string; os: string; arch: string; status: 'unavailable'; reason: string; alternative: string };

function git(args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function binaryName(t: ReleaseTarget): string {
  return `crew-${t.os}-${t.arch}${t.os === 'windows' ? '.exe' : ''}`;
}

const stubInkDevtools: Bun.BunPlugin = {
  name: 'stub-ink-devtools',
  setup(build) {
    build.onResolve({ filter: /devtools\.js$/ }, (args) =>
      /[\\/]ink[\\/]build[\\/]/.test(args.importer) ? { path: 'ink-devtools', namespace: 'crew-stub' } : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: 'crew-stub' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

async function compile(t: ReleaseTarget, outdir: string): Promise<Artifact> {
  const file = binaryName(t);
  const outfile = join(outdir, file);
  try {
    const result = await Bun.build({
      entrypoints: [ENTRY],
      compile: {
        target: t.target,
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
      minify: true,
      sourcemap: 'none',
      plugins: [stubInkDevtools],
      throw: false,
    });
    if (!result.success || !existsSync(outfile)) {
      const reason = result.logs.map((log) => log.message).join('; ') || 'compiler produced no output';
      return { ...t, status: 'unavailable', reason, alternative: BUN_RUNTIME_ALTERNATIVE };
    }
    return { ...t, status: 'available', file, size: statSync(outfile).size, sha256: await sha256File(outfile) };
  } catch (error) {
    const nested = error instanceof AggregateError ? error.errors.map((e: unknown) => String(e)).join('; ') : '';
    const reason = nested || (error instanceof Error ? error.message : String(error));
    return { ...t, status: 'unavailable', reason, alternative: BUN_RUNTIME_ALTERNATIVE };
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      targets: { type: 'string' },
      outdir: { type: 'string', default: join(ROOT, 'dist') },
      strict: { type: 'boolean', default: false },
    },
  });
  const requested = values.targets?.split(',').map((s) => s.trim()) ?? RELEASE_TARGETS.map((t) => t.target);
  const unknown = requested.filter((name) => !RELEASE_TARGETS.some((t) => t.target === name));
  if (unknown.length > 0) {
    console.error(`Unknown target(s): ${unknown.join(', ')}`);
    return 2;
  }
  if (!existsSync(ENTRY)) {
    console.error(`CLI entry not found: ${ENTRY}`);
    return 2;
  }
  const outdir = resolve(values.outdir);
  mkdirSync(outdir, { recursive: true });
  const pkg = (await Bun.file(join(ROOT, 'package.json')).json()) as { name: string; version: string };
  const commit = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
  const sourceDate = git(['log', '-1', '--format=%cI']);

  const artifacts: Artifact[] = [];
  for (const target of RELEASE_TARGETS.filter((t) => requested.includes(t.target))) {
    const artifact = await compile(target, outdir);
    artifacts.push(artifact);
    console.error(
      artifact.status === 'available'
        ? `built ${artifact.file} (${artifact.sha256.slice(0, 12)})`
        : `UNAVAILABLE ${artifact.target}: ${artifact.reason}`,
    );
  }

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    commit,
    sourceDate,
    bunVersion: Bun.version,
    entry: 'apps/cli/src/main.ts',
    targets: artifacts,
    runtimeInstall: BUN_RUNTIME_ALTERNATIVE,
    checksumsFile: 'SHA256SUMS',
  };
  writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeChecksums(outdir);

  const unavailable = artifacts.filter((a) => a.status === 'unavailable');
  if (unavailable.length === artifacts.length) return 1;
  return values.strict && unavailable.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
