import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDirs, silentLogger, systemClock } from '@agent-rail/core';
import { leadershipScope, requestIntegration } from '@agent-rail/integration';
import { acquireLeadership, openRailStore } from '@agent-rail/storage';

const [dataDir, prId, repositoryId, holder] = process.argv.slice(2) as [string, string, string, string];
const dirs = resolveDirs({ RAIL_DATA_DIR: dataDir } as NodeJS.ProcessEnv);
const store = openRailStore({ dirs, durability: 'normal', migrate: false });
const ctx = { store, dirs, logger: silentLogger, clock: systemClock };
while (!existsSync(join(dataDir, 'go'))) await Bun.sleep(5);
const result = await requestIntegration(ctx, { prId, requestedBy: { kind: 'session', id: holder } });
const lease = acquireLeadership(store, leadershipScope(repositoryId, 'main'), holder, 60);
process.stdout.write(JSON.stringify({ created: result.created, entryId: result.entry.id, leader: lease !== null }));
store.close();
