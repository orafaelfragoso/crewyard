import { afterEach, describe, expect, test } from 'bun:test';
import {
  dependencyGraph,
  findReferences,
  findSymbol,
  indexRepository,
  repositoryProfile,
  search,
} from '@crewyard/indexing';
import { createIndexFixture, type IndexFixture, POLYGLOT_FILES } from './fixture.ts';

let fx: IndexFixture | undefined;
afterEach(() => fx?.cleanup());

describe('extraction', () => {
  test('extracts TS, Python and Rust symbols with export flags and signatures', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    const { snapshot, stats } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    expect(snapshot.status).toBe('available');
    expect(stats.mode).toBe('cold');
    const sel = { repositoryId: fx.repositoryId, sha: snapshot.commitSha };

    const add = (await findSymbol(fx.ctx, { ...sel, name: 'add' })).definitions;
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({ path: 'src/math.ts', kind: 'function', exported: true, startLine: 1, endLine: 3 });
    expect(add[0]!.signature).toBe('export function add(a: number, b: number): number'.replace('export ', ''));
    expect(add[0]!.provenance).toMatchObject({
      commitSha: snapshot.commitSha,
      path: 'src/math.ts',
      indexStatus: 'fresh',
    });

    const greet = (await findSymbol(fx.ctx, { ...sel, name: 'User.greet' })).definitions;
    expect(greet[0]).toMatchObject({ path: 'py/pkg/models.py', kind: 'method', container: 'User', exported: true });
    expect((await findSymbol(fx.ctx, { ...sel, name: '_private' })).definitions[0]!.exported).toBe(false);

    const tokenize = (await findSymbol(fx.ctx, { ...sel, name: 'tokenize' })).definitions;
    expect(tokenize[0]).toMatchObject({
      path: 'crate/src/parser.rs',
      kind: 'function',
      exported: true,
      packageRoot: 'crate',
    });
  });

  test('resolves relative, Python and Rust module imports into a dependency graph', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const sel = { repositoryId: fx.repositoryId, sha: snapshot.commitSha };

    const ts = await dependencyGraph(fx.ctx, { ...sel, paths: ['src/math.ts'], direction: 'importedBy', depth: 2 });
    expect(ts.nodes.map((n) => n.path).sort()).toEqual(['README.md', 'src/app.test.ts', 'src/app.ts', 'src/math.ts']);
    const edge = ts.edges.find((e) => e.from === 'src/app.ts');
    expect(edge).toMatchObject({ to: 'src/math.ts', specifier: './math.js', resolution: 'syntax' });
    expect(edge!.names.sort()).toEqual(['Shape', 'add']);

    const py = await dependencyGraph(fx.ctx, { ...sel, paths: ['py/pkg/service.py'], direction: 'imports' });
    expect(py.edges.find((e) => e.specifier === '.models')?.to).toBe('py/pkg/models.py');
    expect(py.edges.find((e) => e.specifier === 'os')?.to).toBeNull();

    const rs = await dependencyGraph(fx.ctx, { ...sel, paths: ['crate/src/lib.rs'], direction: 'imports' });
    const toParser = rs.edges.filter((e) => e.to === 'crate/src/parser.rs');
    expect(toParser).toHaveLength(1);
    expect(toParser[0]!.names.sort()).toEqual(['Token', 'parser']);
  });

  test('references are labeled structural only when the referencing file imports the definition', async () => {
    fx = await createIndexFixture({
      ...POLYGLOT_FILES,
      'src/other.ts': 'function add(x: string) { return x; }\nexport const y = add("1");\n',
    });
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const refs = await findReferences(fx.ctx, {
      repositoryId: fx.repositoryId,
      sha: snapshot.commitSha,
      name: 'add',
      definitionPath: 'src/math.ts',
    });
    const app = refs.references.filter((r) => r.path === 'src/app.ts');
    expect(app.map((r) => r.kind).sort()).toEqual(['call', 'call', 'import']);
    expect(app.every((r) => r.confidence === 'structural')).toBe(true);
    expect(refs.references.find((r) => r.path === 'src/other.ts')?.confidence).toBe('heuristic');
    expect(refs.note).toContain('not a complete semantic');
  });

  test('profile reports packages, commands, docs, workflows and tests; search supports modes', async () => {
    fx = await createIndexFixture(POLYGLOT_FILES);
    const { snapshot } = await indexRepository(fx.ctx, { repositoryId: fx.repositoryId });
    const sel = { repositoryId: fx.repositoryId, sha: snapshot.commitSha };
    const profile = await repositoryProfile(fx.ctx, sel);
    expect(profile.packages.map((p) => `${p.kind}:${p.root}:${p.name}`)).toEqual([
      'npm:.:poly',
      'cargo:crate:crate-demo',
    ]);
    expect(profile.commands.map((c) => c.command)).toContain('npm run test');
    expect(profile.commands.map((c) => c.command)).toContain('cargo test');
    expect(profile.workflows).toEqual(['.github/workflows/ci.yml']);
    expect(profile.docs).toEqual(['README.md']);
    expect(profile.testFileCount).toBe(1);

    const fts = await search(fx.ctx, { ...sel, query: 'tokenize', mode: 'fts' });
    expect(fts.hits.map((h) => h.path)).toContain('crate/src/parser.rs');
    const regex = await search(fx.ctx, { ...sel, query: 'fn \\w+\\(input', mode: 'regex', paths: ['crate/**'] });
    expect(regex.hits.map((h) => `${h.path}:${h.provenance.startLine}`)).toEqual([
      'crate/src/lib.rs:1',
      'crate/src/parser.rs:1',
    ]);
    const exact = await search(fx.ctx, { ...sel, query: 'xs.reduce(', mode: 'exact', contextLines: 0 });
    expect(exact.hits).toHaveLength(1);
    expect(exact.hits[0]).toMatchObject({ path: 'src/app.ts', startLine: 5, endLine: 5 });
    const path = await search(fx.ctx, { ...sel, query: '**/*.py', mode: 'path' });
    expect(path.hits).toHaveLength(3);
  });
});
