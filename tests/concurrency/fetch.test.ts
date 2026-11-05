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

function worker(input: { data: string; repositoryId: string; sha: string }, env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'fetch-worker.ts'), JSON.stringify(input)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env,
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
  return { pid: child.pid!, ready, done, start: () => child.send('go'), stop: () => child.kill() };
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

test.skipIf(process.platform === 'win32')(
  'joined waiters receive owner failure after objects arrive',
  async () => {
    const f = await setup();
    const control = tempDir('crew-fetch-outcome-');
    directories.push(control);
    const realGit = Bun.which('git')!;
    const upload = Bun.which('git-upload-pack')!;
    const started = join(control, 'started');
    const release = join(control, 'release');
    const postReady = join(control, 'post-ready');
    const postRelease = join(control, 'post-release');
    const script = join(control, 'upload');
    writeFileSync(
      script,
      `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nexec '${upload}' "$@"\n`,
    );
    chmodSync(script, 0o700);
    await git(f.local, ['config', 'remote.origin.uploadpack', script]);
    const wrapper = join(control, 'git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nowner=$(cat '${control}/owner' 2>/dev/null)\nif [ "$3" = remote ] && [ "$4" = get-url ] && [ "$PPID" = "$owner" ]; then\n f='${control}/url-'$PPID\n n=0; [ -f "$f" ] && n=$(cat "$f"); n=$((n+1)); echo "$n" > "$f"\n if [ "$n" -ge 2 ]; then touch '${postReady}'; while [ ! -f '${postRelease}' ]; do sleep 0.01; done; fi\nfi\nexec '${realGit}' "$@"\n`,
    );
    chmodSync(wrapper, 0o700);
    const input = { data: f.ctx.dirs.data, repositoryId: f.repository.id, sha: f.sha };
    const owner = worker(input, { ...process.env, PATH: `${control}:${process.env.PATH}` });
    let waiter: ReturnType<typeof worker> | undefined;
    try {
      writeFileSync(join(control, 'owner'), String(owner.pid));
      await owner.ready;
      owner.start();
      await barrier(started);
      waiter = worker(input);
      await waiter.ready;
      waiter.start();
      const deadline = performance.now() + 10_000;
      while (!f.ctx.store.db.query("SELECT 1 FROM events WHERE type = 'repository.fetch_joined'").get()) {
        if (performance.now() > deadline) throw new Error('Waiter did not join');
        await Bun.sleep(5);
      }
      writeFileSync(release, 'go');
      await barrier(postReady);
      await git(f.local, ['remote', 'set-url', 'origin', f.local]);
      writeFileSync(postRelease, 'go');
      expect(await owner.done).toEqual({ error: 'CONFLICT' });
      expect(await waiter.done).toEqual({ error: 'EXTERNAL_FAILURE' });
    } finally {
      writeFileSync(release, 'go');
      writeFileSync(postRelease, 'go');
      owner.stop();
      waiter?.stop();
    }
  },
  20_000,
);

test.skipIf(process.platform === 'win32')(
  'a joined caller recovers a verified dead owner before the claim TTL',
  async () => {
    const f = await setup();
    const control = tempDir('crew-fetch-death-');
    directories.push(control);
    const started = join(control, 'started');
    const release = join(control, 'release');
    const script = join(control, 'upload');
    writeFileSync(
      script,
      `#!/bin/sh\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nexec git-upload-pack "$@"\n`,
    );
    chmodSync(script, 0o700);
    await git(f.local, ['config', 'remote.origin.uploadpack', script]);
    const input = { data: f.ctx.dirs.data, repositoryId: f.repository.id, sha: f.sha };
    const owner = worker(input);
    const ownerExit = owner.done.catch(() => ({ error: 'terminated' }));
    let waiter: ReturnType<typeof worker> | undefined;
    try {
      await owner.ready;
      owner.start();
      await barrier(started);
      waiter = worker(input);
      await waiter.ready;
      waiter.start();
      const deadline = performance.now() + 10_000;
      while (!f.ctx.store.db.query("SELECT 1 FROM events WHERE type = 'repository.fetch_joined'").get()) {
        if (performance.now() > deadline) throw new Error('Waiter did not join');
        await Bun.sleep(5);
      }
      owner.stop();
      await ownerExit;
      writeFileSync(release, 'go');
      expect(await waiter.done).toMatchObject({ result: { commitSha: f.sha, joined: true } });
      expect(
        f.ctx.store.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'repository.fetch_interrupted'").get(),
      ).toEqual({ n: 1 });
    } finally {
      writeFileSync(release, 'go');
      owner.stop();
      waiter?.stop();
    }
  },
  20_000,
);
