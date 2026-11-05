import { writeFileSync } from 'node:fs';
import { type CrewDirs, silentLogger, systemClock } from '@crewyard/core';
import { indexRepository } from '@crewyard/indexing';
import { openCrewStore } from '@crewyard/storage';
const input = JSON.parse(process.argv[2]!) as { dirs: CrewDirs; repositoryId: string; ready: string };
const store = openCrewStore({ dirs: input.dirs, migrate: false });
try {
  writeFileSync(input.ready, 'ready');
  const result = await indexRepository({ store, dirs: input.dirs, logger: silentLogger, clock: systemClock }, { repositoryId: input.repositoryId });
  process.stdout.write(JSON.stringify({ snapshotId: result.snapshot.id, mode: result.stats.mode, error: null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ snapshotId: null, error: (error as { code: string }).code }));
} finally { store.close(); }
