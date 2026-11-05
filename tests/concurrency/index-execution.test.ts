import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listEvents } from '@crewyard/storage';
import { createIndexFixture } from '../unit/indexing/fixture.ts';

async function waitFor(test: () => boolean): Promise<void> {
  const until = performance.now() + 10_000;
  while (!test()) {
    if (performance.now() > until) throw new Error('index process barrier timed out');
    await Bun.sleep(10);
  }
}
for (const expire of [false, true]) {
  test.skipIf(process.platform === 'win32')(
    `two real index processes ${expire ? 'fence expired writes before successor completion' : 'join one exact-SHA build'}`,
    async () => {
      const f = await createIndexFixture({ 'a.ts': 'export const value = 1;\n' });
      const ready = join(f.ctx.root, 'git-ready');
      const release = join(f.ctx.root, 'release');
      const bin = join(f.ctx.root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'git'),
        `#!/bin/sh\ncase "$*" in\n *ls-tree*) echo ready > '${ready}'; while [ ! -e '${release}' ]; do sleep 0.05; done;;\nesac\nexec '${Bun.which('git')!}' "$@"\n`,
        { mode: 0o755 },
      );
      const children: Bun.Subprocess[] = [];
      const run = (name: string) => {
        const started = join(f.ctx.root, name);
        const child = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, '../../fixtures/processes/index-kernel.ts'),
            JSON.stringify({ dirs: f.ctx.dirs, repositoryId: f.repositoryId, ready: started }),
          ],
          { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' },
        );
        children.push(child);
        return {
          started,
          child,
          report: new Response(child.stdout)
            .text()
            .then((text) => JSON.parse(text) as { snapshotId: string; error: string | null; mode: string }),
        };
      };
      try {
        const first = run('first-started');
        await waitFor(() => existsSync(ready));
        if (expire)
          f.ctx.store.immediate((db) =>
            db
              .query("UPDATE execution_claims SET expires_at = '2000-01-01T00:00:00Z' WHERE scope LIKE 'index:build:%'")
              .run(),
          );
        const second = run('second-started');
        await waitFor(() => existsSync(second.started));
        expect(
          f.ctx.store.db
            .query(
              "SELECT COUNT(*) AS n FROM execution_claims WHERE scope LIKE 'index:build:%' AND released_at IS NULL",
            )
            .get(),
        ).toEqual({ n: 1 });
        writeFileSync(release, 'release');
        const [a, b] = await Promise.all([first.report, second.report]);
        expect(b.error).toBeNull();
        if (expire) expect(a.error).toBe('STALE_LEASE');
        else {
          expect(a.snapshotId).toBe(b.snapshotId);
          expect([a.mode, b.mode].sort()).toEqual(['cold', 'noop']);
        }
        expect(listEvents(f.ctx.store, { types: ['index.snapshot_available'] })).toHaveLength(1);
        await Promise.all(children.map((child) => child.exited));
      } finally {
        writeFileSync(release, 'release');
        for (const child of children) child.kill();
        await Promise.all(children.map((child) => child.exited));
        f.cleanup();
      }
    },
    20_000,
  );
}
