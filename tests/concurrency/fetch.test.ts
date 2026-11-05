import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, gitText } from '@crewyard/core';
import { type FetchCommitResult, fetchCommit, registerProject } from '@crewyard/projects';
import { createTempGitRepo, createTestContext, type TestContext, tempDir } from '../helpers/index.ts';

let ctx: TestContext | undefined;
const directories: string[] = [];
afterEach(() => {
  ctx?.cleanup();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function setup() {
  ctx = createTestContext({ durability: 'full' });
  const remote = await createTempGitRepo({ 'input.txt': 'remote data' });
  const local = await createTempGitRepo({ 'local.txt': 'local data' });
  directories.push(remote, local);
  await git(local, ['remote', 'add', 'origin', remote]);
  const { repository } = await registerProject(ctx, {
    repoPath: local,
    baseBranch: 'main',
    actor: { kind: 'operator', id: 'test' },
  });
  return { ctx, remote, local, repository, sha: await gitText(remote, ['rev-parse', 'HEAD']) };
}

function worker(input: { data: string; repositoryId: string; sha: string }) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'fetch-worker.ts'), JSON.stringify(input)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let error = '';
  child.stdout!.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr!.on('data', (chunk) => {
    error += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  const done = new Promise<{ result?: FetchCommitResult; error?: string }>((resolve, reject) => {
    child.once('close', (code) => (code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error))));
    child.once('error', reject);
  });
  return { ready, done, start: () => child.send('go'), stop: () => child.kill() };
}

async function barrier(path: string): Promise<void> {
  const end = performance.now() + 10_000;
  while (!existsSync(path)) {
    if (performance.now() > end) throw new Error(`Missing process barrier ${path}`);
    await Bun.sleep(5);
  }
}

test.skipIf(process.platform === 'win32')(
  '10 processes coalesce one exact-OID transfer without changing canonical refs or FETCH_HEAD',
  async () => {
    const f = await setup();
    const control = tempDir('crew-fetch-barrier-');
    directories.push(control);
    const started = join(control, 'started');
    const release = join(control, 'release');
    const script = join(control, 'upload');
    writeFileSync(
      script,
      `#!/bin/sh\nprintf 'start\\n' >> '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nexec git-upload-pack "$@"\n`,
    );
    chmodSync(script, 0o700);
    await git(f.local, ['config', 'remote.origin.uploadpack', script]);
    const localHead = await gitText(f.local, ['rev-parse', 'main']);
    const children = Array.from({ length: 10 }, () =>
      worker({ data: f.ctx.dirs.data, repositoryId: f.repository.id, sha: f.sha }),
    );
    try {
      await Promise.all(children.map((child) => child.ready));
      for (const child of children) child.start();
      await barrier(started);
      writeFileSync(release, 'go');
      const results = await Promise.all(children.map((child) => child.done));
      expect(results.every((result) => result.result?.commitSha === f.sha)).toBe(true);
      expect(results.filter((result) => result.result?.reused === false)).toHaveLength(1);
      expect(readFileSync(started, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(await gitText(f.local, ['rev-parse', 'main'])).toBe(localHead);
      expect(existsSync(join(f.local, '.git', 'FETCH_HEAD'))).toBe(false);
      expect(await gitText(f.local, ['rev-parse', `refs/crew/objects/${f.sha}`])).toBe(f.sha);
    } finally {
      writeFileSync(release, 'go');
      for (const child of children) child.stop();
    }
  },
  20_000,
);

test('different OIDs remain distinct; a failed fetch is visible and can be retried', async () => {
  const f = await setup();
  const input = {
    repositoryId: f.repository.id,
    remote: 'origin',
    commitSha: f.sha,
    actor: { kind: 'operator' as const, id: 'test' },
  };
  const missing = 'f'.repeat(40);
  await expect(fetchCommit(f.ctx, { ...input, commitSha: missing })).rejects.toMatchObject({
    code: 'EXTERNAL_FAILURE',
  });
  expect(
    f.ctx.store.db
      .query(
        "SELECT json_extract(payload, '$.outcome') AS outcome FROM events WHERE type = 'repository.fetch_finished'",
      )
      .all(),
  ).toEqual([{ outcome: 'failed' }]);
  expect(await fetchCommit(f.ctx, input)).toMatchObject({ commitSha: f.sha, reused: false });
  expect(await fetchCommit(f.ctx, input)).toMatchObject({ commitSha: f.sha, reused: true });
  await expect(fetchCommit(f.ctx, { ...input, commitSha: 'main' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
