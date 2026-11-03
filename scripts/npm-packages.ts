import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dir, '..');

export const MAIN_PACKAGE = 'crewyard';
export const PLATFORM_PREFIX = '@crewyard/cli-';
export const PACKAGES_FILE = 'packages.json';

const NPM_OS: Record<string, string> = { linux: 'linux', darwin: 'darwin', windows: 'win32' };

interface BinaryTarget {
  os: string;
  arch: string;
  status: 'available' | 'unavailable';
  file?: string;
}

interface BinaryManifest {
  version: string;
  targets: BinaryTarget[];
}

export interface RootManifest {
  version: string;
  description: string;
  license: string;
  author: string;
  homepage: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  keywords: string[];
}

export interface NpmPackage {
  name: string;
  version: string;
  dir: string;
  tarball: string | null;
}

export interface BuildNpmPackagesOptions {
  distDir: string;
  outDir: string;
  root: RootManifest;
  pack: boolean;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function shared(root: RootManifest) {
  return {
    license: root.license,
    author: root.author,
    homepage: root.homepage,
    repository: root.repository,
    bugs: root.bugs,
  };
}

async function pack(dir: string, outDir: string): Promise<string> {
  const child = Bun.spawn(['npm', 'pack', '--json', '--pack-destination', outDir], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`npm pack failed in ${dir}: ${stderr.trim()}`);
  type PackEntry = { filename: string };
  const parsed = JSON.parse(stdout) as PackEntry[] | Record<string, PackEntry>;
  const [entry] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (!entry) throw new Error(`npm pack produced no tarball in ${dir}`);
  return basename(entry.filename);
}

export async function buildNpmPackages(options: BuildNpmPackagesOptions): Promise<NpmPackage[]> {
  const { distDir, outDir, root } = options;
  const binaries = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8')) as BinaryManifest;
  if (binaries.version !== root.version) {
    throw new Error(`dist/manifest.json is version ${binaries.version}, package.json is ${root.version}; rebuild`);
  }
  const available = binaries.targets.filter((t) => t.status === 'available' && t.file);
  if (available.length === 0) throw new Error(`no binaries are available in ${distDir}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const license = join(ROOT, 'LICENSE');
  const packages: NpmPackage[] = [];

  for (const target of available) {
    const os = NPM_OS[target.os];
    if (!os) throw new Error(`no npm os mapping for ${target.os}`);
    const name = `${PLATFORM_PREFIX}${os}-${target.arch}`;
    const dir = join(outDir, `cli-${os}-${target.arch}`);
    const executable = os === 'win32' ? 'crew.exe' : 'crew';
    mkdirSync(join(dir, 'bin'), { recursive: true });
    copyFileSync(join(distDir, target.file!), join(dir, 'bin', executable));
    chmodSync(join(dir, 'bin', executable), 0o755);
    copyFileSync(license, join(dir, 'LICENSE'));
    writeFileSync(
      join(dir, 'README.md'),
      `# ${name}\n\nThe \`crew\` binary for ${os} ${target.arch}. Install [\`${MAIN_PACKAGE}\`](https://www.npmjs.com/package/${MAIN_PACKAGE}) instead of this package.\n`,
    );
    writeJson(join(dir, 'package.json'), {
      name,
      version: root.version,
      description: `The crew binary for ${os} ${target.arch}`,
      ...shared(root),
      os: [os],
      cpu: [target.arch],
      files: ['bin'],
      preferUnplugged: true,
      publishConfig: { access: 'public' },
    });
    packages.push({ name, version: root.version, dir, tarball: null });
  }

  const mainDir = join(outDir, MAIN_PACKAGE);
  mkdirSync(join(mainDir, 'bin'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'npm-launcher.cjs'), join(mainDir, 'bin', 'crew.js'));
  chmodSync(join(mainDir, 'bin', 'crew.js'), 0o755);
  copyFileSync(license, join(mainDir, 'LICENSE'));
  copyFileSync(join(ROOT, 'README.md'), join(mainDir, 'README.md'));
  writeJson(join(mainDir, 'package.json'), {
    name: MAIN_PACKAGE,
    version: root.version,
    description: root.description,
    keywords: root.keywords,
    ...shared(root),
    bin: { crew: 'bin/crew.js' },
    files: ['bin'],
    engines: { node: '>=22' },
    optionalDependencies: Object.fromEntries(packages.map((p) => [p.name, root.version])),
    publishConfig: { access: 'public' },
  });
  packages.push({ name: MAIN_PACKAGE, version: root.version, dir: mainDir, tarball: null });

  if (options.pack) {
    const tarballs = await Promise.all(packages.map((p) => pack(p.dir, outDir)));
    packages.forEach((p, i) => {
      p.tarball = tarballs[i] ?? null;
    });
  }
  writeJson(join(outDir, PACKAGES_FILE), packages);
  return packages;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dist: { type: 'string', default: join(ROOT, 'dist') },
      outdir: { type: 'string', default: join(ROOT, 'dist-npm') },
    },
  });
  const distDir = resolve(values.dist);
  if (!existsSync(join(distDir, 'manifest.json'))) {
    console.error(`No manifest.json in ${distDir}; run \`bun run build:binaries\` first.`);
    process.exit(2);
  }
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as RootManifest;
  const packages = await buildNpmPackages({ distDir, outDir: resolve(values.outdir), root, pack: true });
  for (const p of packages) console.error(`packed ${p.name}@${p.version} -> ${p.tarball}`);
}
