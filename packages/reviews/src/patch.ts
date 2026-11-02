import { git, sha256, stableStringify } from '@agent-rail/core';

export interface DiffLine {
  kind: 'add' | 'del';
  text: string;
  line: number;
}

export interface DiffFile {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  binary: boolean;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}

function stripPrefix(path: string): string {
  const clean = unquote(path.trim());
  return clean.startsWith('a/') || clean.startsWith('b/') ? clean.slice(2) : clean;
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(raw);
      const path = match ? stripPrefix(match[2]!) : raw.slice(11);
      current = { path, previousPath: null, status: 'modified', binary: false, lines: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('new file mode')) current.status = 'added';
    else if (raw.startsWith('deleted file mode')) current.status = 'removed';
    else if (raw.startsWith('rename from ')) {
      current.previousPath = raw.slice(12);
      current.status = 'renamed';
    } else if (raw.startsWith('rename to ')) current.path = raw.slice(10);
    else if (raw.startsWith('Binary files ') || raw.startsWith('GIT binary patch')) current.binary = true;
    else if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      if (raw.startsWith('+++ ') && raw.slice(4) !== '/dev/null') current.path = stripPrefix(raw.slice(4));
    } else if (raw.startsWith('@@')) {
      const match = HUNK.exec(raw);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
    } else if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), line: newLine++ });
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), line: oldLine++ });
    } else if (raw.startsWith(' ')) {
      oldLine++;
      newLine++;
    }
  }
  return files;
}

export interface NormalizedFile {
  path: string;
  status: DiffFile['status'];
  hash: string;
}

export interface NormalizedPatch {
  patchHash: string;
  files: NormalizedFile[];
}

export function normalizePatch(patch: string): NormalizedPatch {
  const files = parseUnifiedDiff(patch)
    .map((file) => {
      const lines = file.lines
        .map((l) => `${l.kind === 'add' ? '+' : '-'}${l.text.replace(/\s+/g, '')}`)
        .filter((l) => l.length > 1);
      return {
        path: file.path,
        status: file.status,
        hash: sha256(
          stableStringify({
            path: file.path,
            from: file.previousPath,
            status: file.status,
            binary: file.binary,
            lines,
          }),
        ),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { patchHash: sha256(stableStringify(files.map((f) => [f.path, f.hash]))), files };
}

export async function collectPatch(repoPath: string, baseSha: string, headSha: string): Promise<string> {
  const result = await git(repoPath, ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', `${baseSha}...${headSha}`]);
  return result.stdout;
}
