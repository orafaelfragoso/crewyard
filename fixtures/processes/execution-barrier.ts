import { existsSync, writeFileSync } from 'node:fs';

writeFileSync(process.argv[2]!, String(process.pid));
while (!existsSync(process.argv[3]!)) {
  for (let i = 0; i < 100_000; i++) Math.sqrt(i);
}
