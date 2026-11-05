import { expect, test } from 'bun:test';
import { isProcessAlive, run, withProcessLifecycle } from '@crewyard/core';

test('managed subprocess tracking composes explicit observers and cancellation', async () => {
  const managed = new AbortController();
  const explicit = new AbortController();
  const observed: number[] = [];
  const extra: number[] = [];
  const work = withProcessLifecycle({ signal: managed.signal, onSpawn: (pid) => observed.push(pid) }, () =>
    run([process.execPath, '-e', 'await Bun.sleep(30000)'], {
      signal: explicit.signal,
      onSpawn: (pid) => extra.push(pid),
    }),
  );
  expect(observed).toHaveLength(1);
  expect(extra).toEqual(observed);
  managed.abort(new Error('managed cancellation'));
  await expect(work).rejects.toThrow('managed cancellation');
  expect(explicit.signal.aborted).toBe(false);
  expect(isProcessAlive(observed[0])).toBe(false);
});
