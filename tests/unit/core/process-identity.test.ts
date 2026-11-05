import { expect, test } from 'bun:test';
import { matchesRecordedProcess, processIdentity } from '@crewyard/core';

test('process identity matches its current process and rejects another birth identity', () => {
  const identity = processIdentity(process.pid);
  expect(identity).not.toBeNull();
  expect(matchesRecordedProcess(process.pid, identity)).toBe(true);
  expect(matchesRecordedProcess(process.pid, 'other-boot:other-start')).toBe(false);
  if (process.platform === 'linux') expect(matchesRecordedProcess(process.pid, '12345')).toBeNull();
});

test('run exposes spawned processes and cancels the recorded process', async () => {
  const { isProcessAlive, run } = await import('@crewyard/core');
  const controller = new AbortController();
  let pid = 0;
  const work = run([process.execPath, '-e', 'await Bun.sleep(60000)'], {
    signal: controller.signal,
    onSpawn: (spawned) => {
      pid = spawned;
      controller.abort(new Error('cancelled test child'));
    },
    timeoutMs: 2_000,
    allowFailure: true,
  });
  await expect(work).rejects.toThrow('cancelled test child');
  expect(pid).toBeGreaterThan(0);
  expect(isProcessAlive(pid)).toBe(false);
});
