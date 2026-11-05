import { afterEach, expect, test } from 'bun:test';
import { silentLogger } from '@crewyard/core';
import {
  type PendingHook,
  processIntegrationOutbox,
  runHooks,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { all, type CrewContext, openCrewStore } from '@crewyard/storage';
import { ManualClock } from '../helpers/index.ts';
import { createGitHubFixture, type GitHubFixture } from '../integration/github-fixture.ts';

let fixture: GitHubFixture | undefined;
afterEach(() => fixture?.cleanup());

async function mergedHook() {
  const clock = new ManualClock(new Date());
  const f = await createGitHubFixture({ clock });
  fixture = f;
  await f.pushBranch('feature', { feature: 'yes' });
  const remote = f.mock.addPull({ headRef: 'feature' });
  await syncRepository(f.ctx, f.repositoryId, f.env);
  f.mock.mergeExternally(remote.number);
  await syncRepository(f.ctx, f.repositoryId, f.env);
  const pr = showPullRequest(f.ctx, { repositoryId: f.repositoryId, number: remote.number });
  const at = clock.now().toISOString();
  f.ctx.store.db
    .query(
      "INSERT INTO tasks (id, project_id, title, state, created_at, updated_at, state_changed_at) VALUES ('hook-task', ?, 'Hook task', 'IN_REVIEW', ?, ?, ?)",
    )
    .run(f.projectId, at, at, at);
  f.ctx.store.db.query("UPDATE pull_requests SET task_id = 'hook-task' WHERE id = ?").run(pr.id);
  const call: PendingHook = {
    name: 'onMerged',
    event: {
      taskId: 'hook-task',
      prId: pr.id,
      prNumber: pr.number,
      repositoryId: f.repositoryId,
      mergeCommitSha: pr.mergeCommitSha!,
    },
  };
  return { f, clock, call };
}

test('failed merge hooks survive a store restart and retry once from the durable outbox', async () => {
  const { f, clock, call } = await mergedHook();
  let calls = 0;
  await runHooks(
    f.ctx,
    {
      onMerged: () => {
        calls++;
        throw new Error('hook unavailable');
      },
    },
    [call],
  );
  expect(all(f.ctx.store.db, "SELECT status FROM outbox WHERE kind = 'integration.hook'")).toEqual([
    { status: 'attempted' },
  ]);
  const store = openCrewStore({ dirs: f.ctx.dirs, clock, durability: 'full' });
  const restarted: CrewContext = { store, dirs: f.ctx.dirs, clock, logger: silentLogger };
  try {
    clock.advance(3);
    await processIntegrationOutbox(restarted, {
      leaderId: 'restarted',
      env: {
        hooks: {
          onMerged: () => {
            calls++;
            store.db.query("UPDATE tasks SET state = 'DONE' WHERE id = 'hook-task'").run();
          },
        },
      },
    });
    expect(all(store.db, "SELECT status FROM outbox WHERE kind = 'integration.hook'")).toEqual([
      { status: 'succeeded' },
    ]);
    expect(calls).toBe(2);
    await runHooks(
      restarted,
      {
        onMerged: () => {
          calls++;
        },
      },
      [call],
    );
    expect(calls).toBe(2);
    expect(all(store.db, "SELECT 1 FROM events WHERE type = 'integration.hook_failed'")).toHaveLength(1);
  } finally {
    store.close();
  }
}, 30_000);

test('a callback that completed the task before failing is reconciled without repeating it', async () => {
  const { f, clock, call } = await mergedHook();
  let calls = 0;
  const hooks = {
    onMerged: () => {
      calls++;
      f.ctx.store.db.query("UPDATE tasks SET state = 'DONE' WHERE id = 'hook-task'").run();
      throw new Error('interrupted after state transition');
    },
  };
  await runHooks(f.ctx, hooks, [call]);
  clock.advance(3);
  await processIntegrationOutbox(f.ctx, { leaderId: 'retry', env: { hooks } });
  expect(calls).toBe(1);
  expect(all(f.ctx.store.db, "SELECT status, remote_correlation FROM outbox WHERE kind = 'integration.hook'")).toEqual([
    { status: 'succeeded', remote_correlation: expect.stringContaining('already_applied') },
  ]);
}, 30_000);

test('permanent hook failure has bounded retries and does not revive the same event', async () => {
  const { f, clock, call } = await mergedHook();
  let calls = 0;
  const hooks = {
    onMerged: () => {
      calls++;
      throw new Error('permanent hook failure');
    },
  };
  await runHooks(f.ctx, hooks, [call]);
  for (let i = 0; i < 6; i++) {
    clock.advance(61);
    await processIntegrationOutbox(f.ctx, { leaderId: 'retry', env: { hooks } });
  }
  await runHooks(f.ctx, hooks, [call]);
  expect(calls).toBe(5);
  expect(all(f.ctx.store.db, "SELECT status, attempts FROM outbox WHERE kind = 'integration.hook'")).toEqual([
    { status: 'failed', attempts: 5 },
  ]);
  expect(
    all(
      f.ctx.store.db,
      "SELECT 1 FROM events WHERE type = 'integration.hook_failed' AND json_extract(payload, '$.exhausted') = 1",
    ),
  ).toHaveLength(1);
}, 30_000);
