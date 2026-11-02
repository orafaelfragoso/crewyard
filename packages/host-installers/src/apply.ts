import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { ensureDir, RailError, resolveDirs, sha256, systemClock, toIso } from '@agent-rail/core';
import { defaultExec } from './hosts.ts';
import { type BackupManifest, installerBackupsRoot, MANIFEST_VERSION, type ManifestEntry } from './manifest.ts';
import { formatCommand } from './plan.ts';
import type { ApplyOptions, ApplyResult, CommandChange, FileChange, InstallPlan, PlannedChange } from './types.ts';

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function resolveWriteTarget(path: string): string {
  try {
    return lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  } catch {
    return path;
  }
}

export function writeFileAtomic(path: string, content: string): void {
  const target = resolveWriteTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const temp = join(dirname(target), `.${basename(target)}.agent-rail-${crypto.randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, target);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function pruneEmptyDirs(start: string, stopAt: string): void {
  const stop = resolve(stopAt);
  let dir = resolve(start);
  while (dir !== stop && !relative(stop, dir).startsWith('..') && existsSync(dir)) {
    if (readdirSync(dir).length > 0) return;
    rmdirSync(dir);
    dir = dirname(dir);
  }
}

function applyFile(change: FileChange): void {
  if (change.after === null) {
    if (existsSync(change.path)) unlinkSync(change.path);
    if (change.pruneEmptyDirsUpTo) pruneEmptyDirs(dirname(change.path), change.pruneEmptyDirsUpTo);
  } else {
    writeFileAtomic(change.path, change.after);
  }
}

function revertFile(change: FileChange): void {
  if (change.before === null) {
    if (existsSync(change.path)) unlinkSync(change.path);
  } else {
    writeFileAtomic(change.path, change.before);
  }
}

function stamp(date: Date): string {
  return `${toIso(date).replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`;
}

function writeManifest(path: string, manifest: BackupManifest): void {
  writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertUnchanged(changes: readonly PlannedChange[]): void {
  for (const change of changes) {
    if (change.kind !== 'file') continue;
    if (readOrNull(change.path) !== change.before) {
      throw new RailError('CONFLICT', `${change.path} changed after the plan was created`, {
        details: { path: change.path },
        suggestion: 'Re-run the command to compute a fresh plan.',
      });
    }
  }
}

async function runCommands(change: CommandChange, options: ApplyOptions): Promise<void> {
  const exec = options.exec ?? defaultExec;
  for (const argv of change.commands) {
    const result = await exec(argv, { env: options.env ?? process.env, timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new RailError('EXTERNAL_FAILURE', `${formatCommand(argv.slice(0, 3))} failed (exit ${result.exitCode})`, {
        details: { exitCode: result.exitCode, stderr: result.stderr.trim().slice(0, 500) },
        retryable: false,
        suggestion: `Run it manually: ${formatCommand(argv)}`,
      });
    }
  }
}

export async function applyPlan(plan: InstallPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  if (options.dryRun || plan.changes.length === 0) {
    return {
      dryRun: options.dryRun ?? false,
      backupDir: null,
      manifestPath: null,
      applied: [],
      manualInstructions: plan.manualInstructions,
    };
  }
  assertUnchanged(plan.changes);
  const dirs = options.dirs ?? resolveDirs(options.env ?? process.env);
  const clock = options.clock ?? systemClock;
  const id = stamp(clock.now());
  const backupDir = ensureDir(join(installerBackupsRoot(dirs), id));
  const filesDir = ensureDir(join(backupDir, 'files'));
  const entries: ManifestEntry[] = plan.changes.map((change, index) => {
    const path = change.kind === 'file' ? change.path : change.stateFile;
    const current = readOrNull(path);
    let backupFile: string | null = null;
    if (current !== null) {
      backupFile = join(filesDir, `${String(index).padStart(3, '0')}-${basename(path)}`);
      copyFileSync(path, backupFile);
    }
    if (change.kind === 'command') {
      return {
        kind: 'command',
        path,
        hosts: change.hosts,
        purpose: change.purpose,
        action: 'run',
        existedBefore: current !== null,
        backupFile,
        beforeSha256: current === null ? null : sha256(current),
        afterSha256: null,
        commands: change.commands,
        ownership: change.ownership,
      };
    }
    return {
      kind: 'file',
      path,
      hosts: change.hosts,
      purpose: change.purpose,
      action: change.action,
      existedBefore: change.before !== null,
      backupFile,
      beforeSha256: change.before === null ? null : sha256(change.before),
      afterSha256: change.after === null ? null : sha256(change.after),
      ownership: change.ownership,
    };
  });
  const manifestPath = join(backupDir, 'manifest.json');
  const manifest: BackupManifest = {
    version: MANIFEST_VERSION,
    id,
    kind: plan.kind,
    status: 'pending',
    createdAt: toIso(clock.now()),
    scope: plan.scope,
    targets: plan.targets,
    projectRoot: plan.projectRoot,
    entries,
  };
  writeManifest(manifestPath, manifest);
  const applied: PlannedChange[] = [];
  try {
    for (const change of plan.changes) {
      if (change.kind === 'file') applyFile(change);
      else await runCommands(change, options);
      applied.push(change);
    }
  } catch (error) {
    for (const change of applied.reverse()) if (change.kind === 'file') revertFile(change);
    writeManifest(manifestPath, { ...manifest, status: 'rolled_back' });
    throw error;
  }
  manifest.entries = entries.map((entry) =>
    entry.kind === 'command'
      ? { ...entry, afterSha256: existsSync(entry.path) ? sha256(readFileSync(entry.path)) : null }
      : entry,
  );
  writeManifest(manifestPath, { ...manifest, status: 'applied' });
  return { dryRun: false, backupDir, manifestPath, applied, manualInstructions: plan.manualInstructions };
}

export async function applyUninstall(plan: InstallPlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  if (plan.kind !== 'uninstall') throw new RailError('INVALID_INPUT', 'applyUninstall requires an uninstall plan');
  return applyPlan(plan, options);
}
