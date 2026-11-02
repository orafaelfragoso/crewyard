import { existsSync } from 'node:fs';

const [mode, path] = process.argv.slice(2);
const present = existsSync(path ?? '');
process.exit((mode === 'absent' ? !present : present) ? 0 : 1);
