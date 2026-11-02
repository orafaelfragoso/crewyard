import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { leadershipScope, requestIntegration, showPullRequest, syncRepository } from '@crewyard/integration';
import { all, getLeadership } from '@crewyard/storage';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

let fx: GitHubFixture | undefined;
afterEach(() => fx?.cleanup());

describe('AT-13: concurrent queue mutation', () => {
  test('two MCP hosts and a CLI requesting integration yield one entry and one leader', async () => {
    fx = await createGitHubFixture();
    const f = fx;
    await f.pushBranch('feature', { 'src/feature.ts': 'export const f = 1;\n' });
    const n = f.mock.addPull({ headRef: 'feature' }).number;
    await syncRepository(f.ctx, f.repositoryId, f.env);
    const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: n });
    const worker = join(import.meta.dir, 'github-queue-worker.ts');
    const holders = ['mcp-host-a', 'mcp-host-b', 'cli'];
    const procs = holders.map((holder) =>
      Bun.spawn([process.execPath, worker, f.ctx.dirs.data, pr.id, f.repositoryId, holder], {
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CREW_CONFIG_DIR: join(f.ctx.root, 'config') },
      }),
    );
    await Bun.sleep(150);
    writeFileSync(join(f.ctx.dirs.data, 'go'), '');
    const local = requestIntegration(f.ctx, { prId: pr.id, requestedBy: { kind: 'operator', id: 'local' } }, f.env);
    const outputs = await Promise.all(
      procs.map(async (p) => {
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        await p.exited;
        if (p.exitCode !== 0) throw new Error(err);
        return JSON.parse(out) as { created: boolean; entryId: string; leader: boolean };
      }),
    );
    const inProcess = await local;
    const results = [...outputs, { created: inProcess.created, entryId: inProcess.entry.id, leader: false }];
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(outputs.filter((r) => r.leader)).toHaveLength(1);
    expect(all(f.ctx.store.db, 'SELECT 1 FROM queue_entries')).toHaveLength(1);
    expect(all(f.ctx.store.db, 'SELECT 1 FROM integration_queues')).toHaveLength(1);
    expect(all(f.ctx.store.db, `SELECT 1 FROM events WHERE type = 'queue.entry_requested'`)).toHaveLength(1);
    const lease = getLeadership(f.ctx.store, leadershipScope(f.repositoryId, 'main'));
    expect(holders).toContain(lease?.holderId ?? '');
    expect(lease?.generation).toBe(1);
  }, 30_000);
});
