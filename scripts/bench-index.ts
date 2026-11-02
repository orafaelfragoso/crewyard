import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildContextPack } from '@crewyard/context';
import { canonicalPath, git, resolveDirs, silentLogger, systemClock } from '@crewyard/core';
import { findSymbol, indexRepository, type SearchMode, search } from '@crewyard/indexing';
import { registerProject } from '@crewyard/projects';
import { type CrewContext, openCrewStore } from '@crewyard/storage';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    files: { type: 'string', default: '5000' },
    changed: { type: 'string', default: '100' },
    queries: { type: 'string', default: '200' },
    durability: { type: 'string', default: 'full' },
    json: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    workdir: { type: 'string', default: tmpdir() },
  },
});

const fileCount = Number(values.files);
const changedCount = Number(values.changed);
const queryCount = Number(values.queries);

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function syntheticFile(i: number): [string, string] {
  const pkg = `pkg${i % 50}`;
  const kind = i % 10;
  if (kind < 6) {
    const dep = i >= 50 ? `import { compute${i - 50} } from '../../pkg${(i - 50) % 50}/src/mod${i - 50}.ts';\n` : '';
    const body = Array.from({ length: 12 }, (_, j) => `  const v${j} = input * ${j} + ${i};`).join('\n');
    return [
      `packages/${pkg}/src/mod${i}.ts`,
      `${dep}\nexport interface Record${i} {\n  id: string;\n  value: number;\n}\n\nexport function compute${i}(input: number): number {\n${body}\n  return input + ${i};\n}\n\nexport class Service${i} {\n  run(record: Record${i}): number {\n    return compute${i}(record.value);\n  }\n}\n`,
    ];
  }
  if (kind < 8) {
    return [
      `python/${pkg}/module_${i}.py`,
      `import os\nfrom .helpers import helper\n\n\nclass Handler${i}:\n    def handle(self, value: int) -> int:\n        return helper(value) + ${i}\n\n\ndef process_${i}(items):\n    return [Handler${i}().handle(x) for x in items]\n`,
    ];
  }
  if (kind < 9) {
    return [
      `crates/${pkg}/src/unit_${i}.rs`,
      `use std::collections::HashMap;\n\npub struct Unit${i} {\n    pub id: u64,\n}\n\nimpl Unit${i} {\n    pub fn total(&self, map: &HashMap<u64, u64>) -> u64 {\n        map.get(&self.id).copied().unwrap_or(${i})\n    }\n}\n`,
    ];
  }
  return [`docs/${pkg}/note-${i}.md`, `# Note ${i}\n\nThis note documents compute${i} and Service${i}.\n`];
}

async function generateRepo(n: number): Promise<string> {
  const root = canonicalPath(mkdtempSync(join(values.workdir, 'crew-bench-repo-')));
  write(
    root,
    'package.json',
    JSON.stringify({ name: 'bench', workspaces: ['packages/*'], scripts: { test: 'bun test' } }),
  );
  for (let p = 0; p < 50; p++) {
    write(
      root,
      `packages/pkg${p}/package.json`,
      JSON.stringify({ name: `@bench/pkg${p}`, exports: { '.': './src/index.ts' } }),
    );
    write(root, `python/pkg${p}/helpers.py`, 'def helper(value):\n    return value * 2\n');
  }
  for (let i = 0; i < n; i++) {
    const [path, content] = syntheticFile(i);
    write(root, path, content);
  }
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.email', 'bench@crewyard.local']);
  await git(root, ['config', 'user.name', 'Crewyard Bench']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'bench'], { timeoutMs: 600_000 });
  return root;
}

async function modifyFiles(root: string, n: number): Promise<string> {
  const listing = (await git(root, ['ls-files'])).stdout.split('\n').filter((p) => /\.(ts|py|rs)$/.test(p));
  const step = Math.max(1, Math.floor(listing.length / n));
  for (let k = 0; k < n && k * step < listing.length; k++) {
    const path = listing[k * step]!;
    const file = Bun.file(join(root, path));
    const suffix = path.endsWith('.py')
      ? `\n\ndef bench_extra_${k}():\n    return ${k}\n`
      : path.endsWith('.rs')
        ? `\npub fn bench_extra_${k}() -> u64 { ${k} }\n`
        : `\nexport function benchExtra${k}(): number {\n  return ${k};\n}\n`;
    await Bun.write(file, `${await file.text()}${suffix}`);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', 'bench change']);
  return (await git(root, ['rev-parse', 'HEAD'])).stdout.trim();
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function timeQueries(label: string, n: number, fn: (i: number) => Promise<unknown>) {
  await fn(0);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    samples: n,
    p50Ms: round(percentile(samples, 50)),
    p95Ms: round(percentile(samples, 95)),
    maxMs: round(samples.at(-1) ?? 0),
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

const generated = values.repo === undefined;
const repoPath = values.repo ? canonicalPath(values.repo) : await generateRepo(fileCount);
const dataDir = mkdtempSync(join(values.workdir, 'crew-bench-data-'));
const dirs = resolveDirs({ CREW_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
const store = openCrewStore({ dirs, durability: values.durability === 'normal' ? 'normal' : 'full' });
const ctx: CrewContext = { store, dirs, logger: silentLogger, clock: systemClock };

try {
  const baseBranch = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const { repository } = await registerProject(ctx, { repoPath, baseBranch, actor: { kind: 'operator', id: 'bench' } });

  const coldStart = performance.now();
  const cold = await indexRepository(ctx, { repositoryId: repository.id });
  const coldMs = performance.now() - coldStart;

  let incremental: { ms: number; changed: number; parsed: number } | null = null;
  if (generated) {
    const sha = await modifyFiles(repoPath, changedCount);
    const start = performance.now();
    const result = await indexRepository(ctx, { repositoryId: repository.id, sha });
    incremental = {
      ms: performance.now() - start,
      changed: result.snapshot.changedCount,
      parsed: result.snapshot.parsedCount,
    };
  }

  const sel = { repositoryId: repository.id };
  const symbols = store.db
    .query<{ name: string }, []>('SELECT DISTINCT name FROM symbols WHERE length(name) > 3 ORDER BY random() LIMIT 500')
    .all()
    .map((r) => r.name);
  const pick = (i: number) => symbols[i % Math.max(1, symbols.length)] ?? 'compute';
  const run = (mode: SearchMode) => (i: number) => search(ctx, { ...sel, query: pick(i), mode, limit: 20 });
  const latencies = [
    await timeQueries('fts', queryCount, run('fts')),
    await timeQueries('symbol', queryCount, (i) => findSymbol(ctx, { ...sel, name: pick(i) })),
    await timeQueries('exact', queryCount, run('exact')),
    await timeQueries('hybrid', queryCount, run('hybrid')),
    await timeQueries('context_pack', Math.max(10, Math.floor(queryCount / 4)), (i) =>
      buildContextPack(ctx, { ...sel, query: `${pick(i)} ${pick(i + 7)}` }),
    ),
  ];

  const cpu = cpus()[0];
  const report = {
    machine: {
      cpu: cpu?.model ?? 'unknown',
      cores: cpus().length,
      memoryGb: round(totalmem() / 1024 ** 3),
      freeMemoryGb: round(freemem() / 1024 ** 3),
      os: `${platform()} ${release()}`,
      bun: Bun.version,
    },
    repository: generated ? `synthetic (${fileCount} generated files)` : repoPath,
    durability: values.durability,
    workdir: values.workdir,
    cold: {
      ms: Math.round(coldMs),
      trackedFiles: cold.stats.trackedFiles,
      indexedFiles: cold.stats.indexedFiles,
      parsedBlobs: cold.stats.parsedBlobs,
    },
    incremental: incremental ? { ...incremental, ms: Math.round(incremental.ms) } : null,
    latencies,
    databaseMb: round(Bun.file(dirs.database).size / 1024 ** 2),
  };
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      `machine: ${report.machine.cpu} x${report.machine.cores}, ${report.machine.memoryGb} GB, ${report.machine.os}, bun ${report.machine.bun}`,
    );
    console.log(`repository: ${report.repository} (durability ${report.durability}, workdir ${report.workdir})`);
    console.log(
      `cold index: ${report.cold.ms} ms for ${report.cold.indexedFiles} files (${report.cold.parsedBlobs} blobs parsed)`,
    );
    if (report.incremental) {
      console.log(
        `incremental: ${report.incremental.ms} ms, changed ${report.incremental.changed}, parsed ${report.incremental.parsed}`,
      );
    }
    for (const l of latencies)
      console.log(`${l.label.padEnd(13)} p50 ${l.p50Ms} ms  p95 ${l.p95Ms} ms  max ${l.maxMs} ms  (n=${l.samples})`);
    console.log(`database: ${report.databaseMb} MB`);
  }
} finally {
  store.close();
  if (!values.keep) {
    rmSync(dataDir, { recursive: true, force: true });
    if (generated) rmSync(repoPath, { recursive: true, force: true });
  }
}
