import { resolveDirs, silentLogger, systemClock } from '@crewyard/core';
import { fetchCommit } from '@crewyard/projects';
import { openCrewStore } from '@crewyard/storage';

const input = JSON.parse(process.argv[2]!) as { data: string; repositoryId: string; sha: string };
const dirs = resolveDirs({ CREW_DATA_DIR: input.data });
const store = openCrewStore({ dirs, durability: 'full' });
process.on('message', async () => {
  try {
    const result = await fetchCommit(
      { store, dirs, clock: systemClock, logger: silentLogger },
      {
        repositoryId: input.repositoryId,
        remote: 'origin',
        commitSha: input.sha,
        actor: { kind: 'service', id: 'fetch-test' },
      },
    );
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as { code?: string }).code }));
  } finally {
    store.close();
    process.disconnect?.();
  }
});
process.send?.('ready');
