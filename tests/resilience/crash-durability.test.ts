import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveDirs } from '@crewyard/core';
import { openCrewStore } from '@crewyard/storage';
import { tempDir } from '../helpers/index.ts';

const WORKER = join(import.meta.dir, 'crash-worker.ts');

async function crashRun(dataDir: string, runId: number): Promise<number> {
  const proc = Bun.spawn([process.execPath, WORKER, dataDir, String(runId)], { stdout: 'pipe', stderr: 'ignore' });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let lastAck = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) lastAck = Number(line.split(' ')[0]);
    if (lastAck >= 0 && timer === undefined)
      timer = setTimeout(() => proc.kill('SIGKILL'), Math.floor(Math.random() * 40));
  }
  clearTimeout(timer);
  await proc.exited;
  return lastAck;
}

describe('crash durability', () => {
  test('no acknowledged transition is lost across 100 SIGKILL crashes (synchronous=FULL)', async () => {
    const dataDir = join(tempDir('crew-crash-'), 'data');
    openCrewStore({ dirs: resolveDirs({ CREW_DATA_DIR: dataDir } as NodeJS.ProcessEnv) }).close();
    const acks: number[] = [];
    for (let run = 0; run < 100; run++) acks.push(await crashRun(dataDir, run));
    const store = openCrewStore({ dirs: resolveDirs({ CREW_DATA_DIR: dataDir } as NodeJS.ProcessEnv) });
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
      expect(acknowledged).toBe(100);
    } finally {
      store.close();
    }
  }, 120_000);
});
