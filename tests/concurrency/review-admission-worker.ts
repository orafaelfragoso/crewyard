import { appendFileSync, existsSync } from 'node:fs';
import { crewConfigSchema } from '@crewyard/config';
import { resolveDirs, silentLogger, systemClock } from '@crewyard/core';
import { collectPatch, type Reviewer, requestReview } from '@crewyard/reviews';
import { openCrewStore } from '@crewyard/storage';

const [
  dataDir,
  repositoryPath,
  baseSha,
  commitSha,
  markerPath,
  releasePath,
  force,
  cacheEnabled,
  type,
  crashAfterResult,
] = process.argv.slice(2) as [string, string, string, string, string, string, string, string, string, string];
const dirs = resolveDirs({ CREW_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
const store = openCrewStore({ dirs, clock: systemClock });
const ctx = { store, dirs, clock: systemClock, logger: silentLogger };
const reviewer: Reviewer = {
  identity: 'shared-provider',
  model: 'fixture',
  promptVersion: '1',
  async review() {
    appendFileSync(markerPath, `${process.pid}\n`);
    const deadline = performance.now() + 15_000;
    while (!existsSync(releasePath)) {
      if (performance.now() > deadline) throw new Error('provider barrier deadline');
      await Bun.sleep(10);
    }
    const result = { confidence: 0.9, findings: [] };
    if (crashAfterResult === 'true') process.exit(23);
    return result;
  },
};
try {
  const patch = await collectPatch(repositoryPath, baseSha, commitSha);
  const result = await requestReview(
    ctx,
    {
      repositoryId: 'repo',
      prId: 'pr',
      commitSha,
      baseSha,
      patch,
      types: [type === 'security' ? 'security' : 'code'],
      force: force === 'true',
    },
    {
      config: crewConfigSchema.parse({
        version: 1,
        project: { name: 'test' },
        review: { cache_enabled: cacheEnabled === 'true' },
      }),
      reviewers: { code: reviewer, security: reviewer },
    },
  );
  console.log(JSON.stringify(result));
} finally {
  store.close();
}
