import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNpmPackages, type RootManifest } from '../../../scripts/npm-packages.ts';

const ROOT: RootManifest = {
  version: '1.2.3',
  description: 'test',
  license: 'MIT',
  author: 'test',
  homepage: 'https://example.test',
  repository: { type: 'git', url: 'git+https://example.test/repo.git' },
  bugs: { url: 'https://example.test/issues' },
  keywords: [],
};

const dirs: string[] = [];

function fakeDist(version: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'crew-npm-dist-'));
  dirs.push(dist);
  writeFileSync(join(dist, 'crew-linux-x64'), 'linux');
  writeFileSync(join(dist, 'crew-windows-x64.exe'), 'windows');
  const targets = [
    { os: 'linux', arch: 'x64', status: 'available', file: 'crew-linux-x64' },
    { os: 'windows', arch: 'x64', status: 'available', file: 'crew-windows-x64.exe' },
    { os: 'darwin', arch: 'arm64', status: 'unavailable', reason: 'test' },
  ];
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ version, targets }));
  return dist;
}

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-npm-out-'));
  dirs.push(dir);
  return dir;
}

function manifest(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('npm packages', () => {
  test('publishes platform packages before the launcher package that pins them', () => {
    const packages = buildNpmPackages({ distDir: fakeDist('1.2.3'), outDir: outDir(), root: ROOT, pack: false });
    expect(packages.map((p) => p.name)).toEqual(['@crewyard/cli-linux-x64', '@crewyard/cli-win32-x64', 'crewyard']);
    const main = manifest(packages[2]!.dir);
    expect(main.bin).toEqual({ crew: 'bin/crew.js' });
    expect(main.optionalDependencies).toEqual({
      '@crewyard/cli-linux-x64': '1.2.3',
      '@crewyard/cli-win32-x64': '1.2.3',
    });
  });

  test('maps each binary to npm os and cpu with an executable crew binary', () => {
    const [linux, windows] = buildNpmPackages({
      distDir: fakeDist('1.2.3'),
      outDir: outDir(),
      root: ROOT,
      pack: false,
    });
    expect(manifest(linux!.dir)).toMatchObject({ os: ['linux'], cpu: ['x64'], version: '1.2.3' });
    expect(manifest(windows!.dir)).toMatchObject({ os: ['win32'], cpu: ['x64'] });
    expect(manifest(linux!.dir).bin).toBeUndefined();
    expect(readFileSync(join(windows!.dir, 'bin', 'crew.exe'), 'utf8')).toBe('windows');
    if (process.platform !== 'win32') expect(statSync(join(linux!.dir, 'bin', 'crew')).mode & 0o111).toBe(0o111);
  });

  test('refuses binaries built for another version', () => {
    expect(() => buildNpmPackages({ distDir: fakeDist('1.2.2'), outDir: outDir(), root: ROOT, pack: false })).toThrow(
      /version 1\.2\.2/,
    );
  });
});
