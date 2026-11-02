import { DEFAULT_ENV_ALLOWLIST, RailError, run, sanitizeEnv } from '@agent-rail/core';

const MAX_LISTING_BYTES = 1024 * 1024 * 1024;

function gitEnv(): Record<string, string> {
  return sanitizeEnv(process.env, [...DEFAULT_ENV_ALLOWLIST, 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'], {
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  });
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await run(['git', '-c', 'core.quotepath=off', ...args], {
    cwd,
    env: gitEnv(),
    maxOutputBytes: MAX_LISTING_BYTES,
    allowFailure: true,
    timeoutMs: 600_000,
  });
  if (result.exitCode !== 0 || result.truncated) {
    throw new RailError('EXTERNAL_FAILURE', `git ${args[0]} failed: ${result.stderr.trim().slice(0, 500)}`, {
      details: { args: args.slice(0, 6), exitCode: result.exitCode, truncated: result.truncated },
      retryable: false,
    });
  }
  return result.stdout;
}

export interface TreeEntry {
  path: string;
  mode: string;
  blobSha: string;
  size: number;
}

const PATHSPEC_BATCH = 100;

export async function listTree(cwd: string, commitSha: string, paths?: readonly string[]): Promise<TreeEntry[]> {
  if (paths !== undefined) {
    const wanted = new Set(paths);
    if (paths.length > PATHSPEC_BATCH * 2) return (await listTree(cwd, commitSha)).filter((e) => wanted.has(e.path));
    const out: TreeEntry[] = [];
    for (let i = 0; i < paths.length; i += PATHSPEC_BATCH) {
      const batch = paths.slice(i, i + PATHSPEC_BATCH);
      const text = await gitOutput(cwd, [
        '--literal-pathspecs',
        'ls-tree',
        '-r',
        '-z',
        '--long',
        '--full-tree',
        commitSha,
        '--',
        ...batch,
      ]);
      out.push(...parseTree(text).filter((e) => wanted.has(e.path)));
    }
    return out;
  }
  return parseTree(await gitOutput(cwd, ['ls-tree', '-r', '-z', '--long', '--full-tree', commitSha]));
}

function parseTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha, size] = record.slice(0, tab).split(/ +/);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    entries.push({ path: record.slice(tab + 1), mode: mode, blobSha: sha!, size: Number(size) });
  }
  return entries;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'T';

export interface TreeChange {
  status: ChangeStatus;
  path: string;
  oldPath: string | null;
  newBlobSha: string | null;
  newMode: string;
}

const ZERO_SHA = /^0+$/;

export async function diffTrees(cwd: string, fromSha: string, toSha: string): Promise<TreeChange[]> {
  const out = await gitOutput(cwd, [
    'diff-tree',
    '-r',
    '-z',
    '-M',
    '--raw',
    '--no-abbrev',
    '--no-commit-id',
    fromSha,
    toSha,
  ]);
  const parts = out.split('\0');
  const changes: TreeChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const meta = parts[i++];
    if (!meta?.startsWith(':')) continue;
    const [, newMode, , newSha, statusField] = meta.slice(1).split(' ');
    const letter = statusField![0]!;
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]!;
      const path = parts[i++]!;
      changes.push({
        status: letter === 'R' ? 'R' : 'A',
        path,
        oldPath: letter === 'R' ? oldPath : null,
        newBlobSha: newSha!,
        newMode: newMode!,
      });
      continue;
    }
    const path = parts[i++]!;
    const status: ChangeStatus = letter === 'A' || letter === 'D' || letter === 'T' ? letter : 'M';
    changes.push({
      status,
      path,
      oldPath: null,
      newBlobSha: ZERO_SHA.test(newSha!) ? null : newSha!,
      newMode: newMode!,
    });
  }
  return changes;
}

export async function treeSha(cwd: string, commitSha: string): Promise<string> {
  return (await gitOutput(cwd, ['rev-parse', `${commitSha}^{tree}`])).trim();
}

export async function ancestors(cwd: string, commitSha: string, max: number): Promise<string[]> {
  return (await gitOutput(cwd, ['rev-list', `--max-count=${max}`, commitSha])).split('\n').filter(Boolean);
}

export async function hasCommit(cwd: string, sha: string): Promise<boolean> {
  const result = await run(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd, env: gitEnv(), allowFailure: true });
  return result.exitCode === 0;
}

export interface BlobContent {
  sha: string;
  size: number;
  bytes: Uint8Array | null;
}

class StreamBuffer {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private available = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done) return false;
    this.chunks.push(value);
    this.available += value.byteLength;
    return true;
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      let scanned = 0;
      for (let c = 0; c < this.chunks.length; c++) {
        const chunk = this.chunks[c]!;
        const start = c === 0 ? this.offset : 0;
        const index = chunk.indexOf(10, start);
        if (index !== -1) {
          const line = this.take(scanned + index - start);
          this.take(1);
          return Buffer.from(line).toString('utf8');
        }
        scanned += chunk.byteLength - start;
      }
      if (!(await this.fill())) return null;
    }
  }

  async readBytes(n: number): Promise<Uint8Array> {
    while (this.available < n) {
      if (!(await this.fill())) throw new RailError('EXTERNAL_FAILURE', 'git cat-file output ended unexpectedly');
    }
    return this.take(n);
  }

  private take(n: number): Uint8Array {
    this.available -= n;
    const first = this.chunks[0];
    if (first && first.byteLength - this.offset >= n) {
      const out = first.subarray(this.offset, this.offset + n);
      this.offset += n;
      if (this.offset === first.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
      return out;
    }
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.chunks[0]!;
      const piece = chunk.subarray(this.offset, this.offset + (n - written));
      out.set(piece, written);
      written += piece.byteLength;
      this.offset += piece.byteLength;
      if (this.offset === chunk.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
}

export async function* readBlobs(cwd: string, shas: readonly string[], maxBytes: number): AsyncGenerator<BlobContent> {
  if (shas.length === 0) return;
  const proc = Bun.spawn(['git', 'cat-file', '--batch'], {
    cwd,
    env: gitEnv(),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const writer = (async () => {
    for (let i = 0; i < shas.length; i++) {
      proc.stdin.write(`${shas[i]}\n`);
      if (i % 256 === 255) await proc.stdin.flush();
    }
    await proc.stdin.end();
  })();
  const buffer = new StreamBuffer(proc.stdout.getReader());
  try {
    for (let i = 0; i < shas.length; i++) {
      const header = await buffer.readLine();
      if (header === null) throw new RailError('EXTERNAL_FAILURE', 'git cat-file terminated early');
      const [sha, type, sizeText] = header.split(' ');
      if (type === 'missing' || type === undefined) {
        throw new RailError('EXTERNAL_FAILURE', `Git object missing: ${sha}`, { retryable: false });
      }
      const size = Number(sizeText);
      const bytes = await buffer.readBytes(size);
      await buffer.readBytes(1);
      yield { sha: sha!, size, bytes: size > maxBytes ? null : bytes };
    }
    await writer;
  } finally {
    if (proc.exitCode === null) proc.kill();
    await proc.exited;
    await writer.catch(() => undefined);
  }
}
