import { resolveDirs } from '@crewyard/core';
import { appendEvent, openCrewStore } from '@crewyard/storage';

const [dataDir, runId] = process.argv.slice(2);
const store = openCrewStore({
  dirs: resolveDirs({ CREW_DATA_DIR: dataDir! } as NodeJS.ProcessEnv),
  durability: 'full',
});
for (let i = 0; ; i++) {
  const seq = store.immediate((db) => {
    db.query(
      'INSERT INTO sequences (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
    ).run(`crash:${runId}`, i);
    return appendEvent(db, { type: 'crash.ack', actor: { kind: 'system', id: 'crash' }, payload: { runId, i } }).seq;
  });
  process.stdout.write(`${i} ${seq}\n`);
}
