import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { crewConfigSchema } from '@crewyard/config';
import { isCrewError, resolveDirs, silentLogger, systemClock } from '@crewyard/core';
import { type CrewContext, openStore } from '@crewyard/storage';
import { claimTask, heartbeat, releaseLease } from '@crewyard/tasks';

interface WorkerArgs {
  dataDir: string;
  lockDir: string;
  agentId: string;
  taskIds: string[];
  startAt: number;
  targetClaims: number;
  mode: 'single' | 'stress';
}

export interface ClaimLogEntry {
  taskId: string;
  generation: number;
}

export interface WorkerReport {
  agentId: string;
  claims: ClaimLogEntry[];
  outcomes: Record<string, number>;
  violations: string[];
}

const args = JSON.parse(process.argv[2]!) as WorkerArgs;
const dirs = resolveDirs({ CREW_DATA_DIR: args.dataDir } as NodeJS.ProcessEnv);
const store = openStore({ path: dirs.database, durability: 'normal', busyTimeoutMs: 10_000 });
const ctx: CrewContext = { store, dirs, logger: silentLogger, clock: systemClock };
const config = crewConfigSchema.parse({ version: 1, project: { name: 'stress' } });
const report: WorkerReport = { agentId: args.agentId, claims: [], outcomes: {}, violations: [] };
const bump = (key: string) => {
  report.outcomes[key] = (report.outcomes[key] ?? 0) + 1;
};

while (Date.now() < args.startAt) await Bun.sleep(1);

let attempts = 0;
while (report.claims.length < args.targetClaims && attempts < args.targetClaims * 400) {
  attempts++;
  const taskId = args.taskIds[Math.floor(Math.random() * args.taskIds.length)]!;
  let claim: ReturnType<typeof claimTask>;
  try {
    claim = claimTask(ctx, { taskId, holder: { kind: 'agent', id: args.agentId }, config });
  } catch (error) {
    bump(isCrewError(error) ? error.code : 'UNEXPECTED');
    if (args.mode === 'single') break;
    continue;
  }
  bump('CLAIMED');
  report.claims.push({ taskId, generation: claim.generation });
  if (args.mode === 'single') break;
  const marker = join(args.lockDir, `${taskId}.owner`);
  let fd: number | null = null;
  try {
    fd = openSync(marker, 'wx');
  } catch {
    report.violations.push(`${args.agentId} claimed ${taskId}#${claim.generation} while another owner was active`);
  }
  const active = store.db
    .query('SELECT COUNT(*) AS n FROM leases WHERE task_id = ? AND released_at IS NULL')
    .get(taskId) as { n: number };
  if (active.n !== 1) report.violations.push(`${taskId} had ${active.n} active leases`);
  heartbeat(ctx, claim, { config });
  if (fd !== null) {
    closeSync(fd);
    unlinkSync(marker);
  }
  for (;;) {
    try {
      releaseLease(ctx, claim);
      break;
    } catch (error) {
      if (!(isCrewError(error) && error.code === 'BUSY')) throw error;
    }
  }
}

store.close();
process.stdout.write(`${JSON.stringify(report)}\n`);
