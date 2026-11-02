import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CHECKSUMS_FILE = 'SHA256SUMS';

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

export async function writeChecksums(dir: string): Promise<Record<string, string>> {
  const files = readdirSync(dir)
    .filter((name) => name !== CHECKSUMS_FILE && !name.startsWith('.') && statSync(join(dir, name)).isFile())
    .sort();
  const sums: Record<string, string> = {};
  for (const name of files) sums[name] = await sha256File(join(dir, name));
  writeFileSync(join(dir, CHECKSUMS_FILE), files.map((name) => `${sums[name]}  ${name}\n`).join(''));
  return sums;
}

if (import.meta.main) {
  const dir = resolve(process.argv[2] ?? join(import.meta.dir, '..', 'dist'));
  const sums = await writeChecksums(dir);
  console.log(`Wrote ${join(dir, CHECKSUMS_FILE)} (${Object.keys(sums).length} files)`);
}
