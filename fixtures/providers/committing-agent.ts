import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const file = process.argv[2] ?? 'CHANGELOG.md';
emit({ type: 'session', id: `committing-${process.pid}` });
appendFileSync(join(process.cwd(), file), `change by ${process.env.RAIL_TASK_ID ?? 'unknown task'}\n`);
const run = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: process.cwd(), stdout: 'ignore', stderr: 'pipe' });
run('add', '-A');
const commit = run('-c', 'user.email=agent@rail.local', '-c', 'user.name=Rail Agent', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `work for ${process.env.RAIL_TASK_ID}`);
if (commit.exitCode !== 0) {
  emit({ type: 'error', message: commit.stderr.toString() });
  process.exit(1);
}
emit({ type: 'result', text: 'committed' });
