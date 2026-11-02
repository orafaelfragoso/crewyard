import { describe, expect, test } from 'bun:test';
import { generateSbom, parseBunLock } from '../../../scripts/sbom.ts';

const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "app", "version": "2.0.0", "devDependencies": { "lint": "1.0.0" } },
    "packages/lib": { "name": "@app/lib", "version": "1.0.0", "dependencies": { "@scope/a": "^1.0.0" } },
  },
  "packages": {
    "@app/lib": ["@app/lib@workspace:packages/lib"],
    "@scope/a": ["@scope/a@1.2.3", "", { "dependencies": { "b": "^2.0.0" } }, "sha512-AAEC"],
    "b": ["b@2.0.0", "", {}, "sha512-AwQF"],
    "@scope/a/b": ["b@1.0.0", "", {}, "sha512-BgcI"],
    "lint": ["lint@1.0.0", "", { "dependencies": { "b": "^2.0.0" } }, "sha512-CQoL"],
  }
}`;

describe('sbom', () => {
  const bom = generateSbom(parseBunLock(LOCK), { serialNumber: 'urn:uuid:x', timestamp: '2026-11-02T00:00:00.000Z' });
  const components = bom.components as {
    name: string;
    version: string;
    scope: string;
    purl?: string;
    hashes?: { content: string }[];
    'bom-ref': string;
  }[];

  test('emits CycloneDX 1.6 with one component per lockfile entry', () => {
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 });
    expect(components).toHaveLength(5);
  });

  test('resolves nested lockfile keys and scopes dev-only packages as excluded', () => {
    const byRef = Object.fromEntries(components.map((c) => [c['bom-ref'], c]));
    expect(byRef['pkg:npm/b@1.0.0#@scope/a/b']?.scope).toBe('required');
    expect(byRef['pkg:npm/b@2.0.0#b']?.scope).toBe('excluded');
    expect(byRef['pkg:npm/lint@1.0.0#lint']?.scope).toBe('excluded');
    const deps = bom.dependencies as { ref: string; dependsOn: string[] }[];
    expect(deps.find((d) => d.ref.endsWith('#@scope/a'))?.dependsOn).toEqual(['pkg:npm/b@1.0.0#@scope/a/b']);
  });

  test('encodes scoped purls and converts integrity to hex', () => {
    const a = components.find((c) => c.name === 'a')!;
    expect(a.purl).toBe('pkg:npm/%40scope/a@1.2.3');
    expect(a.hashes?.[0]?.content).toBe('000102');
  });

  test('rejects files that are not bun text lockfiles', () => {
    expect(() => parseBunLock('{"name": "x"}')).toThrow();
  });
});
