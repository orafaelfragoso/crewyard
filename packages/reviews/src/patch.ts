import { CrewError, git, sha256 } from '@crewyard/core';

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
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(raw);
      const path = match ? stripPrefix(match[2]!) : raw.slice(11);
      current = { path, previousPath: null, status: 'modified', binary: false, lines: [] };
      files.push(current);
      inHunk = false;
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
      inHunk = match !== null;
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
    } else if (inHunk && raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), line: newLine++ });
    } else if (inHunk && raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), line: oldLine++ });
    } else if (inHunk && raw.startsWith(' ')) {
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
  const sections = patch.split(/(?=^diff --git )/m).filter((section) => section.startsWith('diff --git '));
  const files = parseUnifiedDiff(patch)
    .map((file, index) => ({ path: file.path, status: file.status, hash: sha256(sections[index]!) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { patchHash: sha256(patch), files };
}

export interface SourceChange {
  oldPath: string | null;
  newPath: string | null;
  oldBlob: string | null;
  newBlob: string | null;
  oldMode: string;
  newMode: string;
  status: string;
  binary: boolean;
  oldEndsWithNewline: boolean | null;
  newEndsWithNewline: boolean | null;
}

export type ReviewSource =
  | {
      kind: 'git';
      objectFormat: string;
      baseTree: string;
      mergeBaseTree: string;
      headTree: string;
      changes: SourceChange[];
    }
  | { kind: 'synthetic'; patchHash: string };

export interface CollectedReviewSource {
  source: Extract<ReviewSource, { kind: 'git' }>;
  patch: string;
  files: DiffFile[];
}

async function completeGit(repoPath: string, args: string[], maxOutputBytes: number): Promise<string> {
  const result = await git(repoPath, args, { maxOutputBytes });
  if (result.truncated) throw new CrewError('INVALID_INPUT', 'Review source exceeds the complete-input limit');
  return result.stdout;
}

export async function collectReviewSource(
  repoPath: string,
  baseSha: string,
  headSha: string,
  maxOutputBytes: number,
): Promise<CollectedReviewSource> {
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(baseSha) || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(headSha))
    throw new CrewError('INVALID_INPUT', 'Review source requires immutable commit object IDs');
  const mergeBase = (await completeGit(repoPath, ['merge-base', baseSha, headSha], maxOutputBytes)).trim();
  const [objectFormat, trees, raw, patch] = await Promise.all([
    completeGit(repoPath, ['rev-parse', '--show-object-format'], maxOutputBytes),
    completeGit(
      repoPath,
      ['rev-parse', `${baseSha}^{tree}`, `${mergeBase}^{tree}`, `${headSha}^{tree}`],
      maxOutputBytes,
    ),
    completeGit(
      repoPath,
      ['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '-M', mergeBase, headSha, '--'],
      maxOutputBytes,
    ),
    completeGit(
      repoPath,
      [
        '-c',
        'core.quotePath=true',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--full-index',
        '--binary',
        '-M',
        '-U3',
        mergeBase,
        headSha,
        '--',
      ],
      maxOutputBytes,
    ),
  ]);
  const fields = raw.split('\0');
  const changes: SourceChange[] = [];
  for (let i = 0; i < fields.length - 1; ) {
    const header = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z]\d*)$/.exec(fields[i++]!);
    if (!header) throw new CrewError('INVALID_INPUT', 'Invalid Git review change manifest');
    const oldMode = header[1]!;
    const newMode = header[2]!;
    const oldOid = header[3]!;
    const newOid = header[4]!;
    const status = header[5]!;
    const first = fields[i++]!;
    const second = status.startsWith('R') || status.startsWith('C') ? fields[i++]! : first;
    changes.push({
      oldPath: oldMode === '000000' ? null : first,
      newPath: newMode === '000000' ? null : second,
      oldBlob: /^0+$/.test(oldOid) ? null : oldOid,
      newBlob: /^0+$/.test(newOid) ? null : newOid,
      oldMode,
      newMode,
      status,
      binary: false,
      oldEndsWithNewline: null,
      newEndsWithNewline: null,
    });
  }
  const blobs = new Map<string, { binary: boolean; newline: boolean }>();
  for (const change of changes) {
    for (const [oid, mode] of [
      [change.oldBlob, change.oldMode],
      [change.newBlob, change.newMode],
    ] as const) {
      if (oid === null || mode === '160000' || blobs.has(oid)) continue;
      const content = await completeGit(repoPath, ['cat-file', 'blob', oid], maxOutputBytes);
      blobs.set(oid, { binary: content.includes('\0'), newline: content.endsWith('\n') });
    }
    const old = change.oldBlob ? blobs.get(change.oldBlob) : undefined;
    const next = change.newBlob ? blobs.get(change.newBlob) : undefined;
    change.binary = old?.binary === true || next?.binary === true;
    change.oldEndsWithNewline = old?.newline ?? null;
    change.newEndsWithNewline = next?.newline ?? null;
  }
  const parsed = parseUnifiedDiff(patch);
  if (parsed.length !== changes.length) throw new CrewError('INVALID_INPUT', 'Incomplete review patch coverage');
  const files = parsed.map((file, i) => {
    const change = changes[i]!;
    change.binary ||= file.binary;
    return {
      ...file,
      path: change.newPath ?? change.oldPath!,
      previousPath: change.oldPath !== change.newPath ? change.oldPath : null,
      binary: change.binary,
    };
  });
  const [baseTree, mergeBaseTree, headTree] = trees.trim().split('\n') as [string, string, string];
  return {
    source: { kind: 'git', objectFormat: objectFormat.trim(), baseTree, mergeBaseTree, headTree, changes },
    patch,
    files,
  };
}

export async function collectPatch(repoPath: string, baseSha: string, headSha: string): Promise<string> {
  return (await collectReviewSource(repoPath, baseSha, headSha, 16 * 1024 * 1024)).patch;
}
