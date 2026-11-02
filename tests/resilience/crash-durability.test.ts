import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveDirs } from '@agent-rail/core';
import { openRailStore } from '@agent-rail/storage';
import { tempDir } from '../helpers/index.ts';

const WORKER = join(import.meta.dir, 'crash-worker.ts');

async function crashRun(dataDir: string, runId: number): Promise<number> {
  const proc = Bun.spawn([process.execPath, WORKER, dataDir, String(runId)], { stdout: 'pipe', stderr: 'ignore' });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let lastAck = -1;
  const killAfter = 20 + Math.floor(Math.random() * 60);
  const timer = setTimeout(() => proc.kill('SIGKILL'), killAfter);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) lastAck = Number(line.split(' ')[0]);
  }
  clearTimeout(timer);
  await proc.exited;
  return lastAck;
}

describe('crash durability', () => {
  test('no acknowledged transition is lost across 100 SIGKILL crashes (synchronous=FULL)', async () => {
    const dataDir = join(tempDir('rail-crash-'), 'data');
    openRailStore({ dirs: resolveDirs({ RAIL_DATA_DIR: dataDir } as NodeJS.ProcessEnv) }).close();
    const acks: number[] = [];
    for (let run = 0; run < 100; run++) acks.push(await crashRun(dataDir, run));
    const store = openRailStore({ dirs: resolveDirs({ RAIL_DATA_DIR: dataDir } as NodeJS.ProcessEnv) });
    try {
      expect((store.db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe(
        'ok',
      );
      let acknowledged = 0;
      for (let run = 0; run < 100; run++) {
        const ack = acks[run]!;
        if (ack < 0) continue;
        acknowledged++;
        const row = store.db.query('SELECT value FROM sequences WHERE name = ?').get(`crash:${run}`) as {
          value: number;
        } | null;
        expect(row?.value ?? -1).toBeGreaterThanOrEqual(ack);
        const events = (
          store.db
            .query(`SELECT COUNT(*) AS n FROM events WHERE type = 'crash.ack' AND json_extract(payload, '$.runId') = ?`)
            .get(String(run)) as { n: number }
        ).n;
        expect(events).toBeGreaterThanOrEqual(ack + 1);
      }
      expect(acknowledged).toBeGreaterThan(50);
    } finally {
      store.close();
    }
  }, 120_000);
});
