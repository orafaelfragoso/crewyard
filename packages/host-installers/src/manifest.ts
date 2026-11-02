import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RailDirs } from '@agent-rail/core';
import type { ChangePurpose, HostId, InstallScope, Ownership } from './types.ts';

export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  kind: 'file' | 'command';
  path: string;
  hosts: HostId[];
  purpose: ChangePurpose;
  action: 'create' | 'modify' | 'delete' | 'run';
  existedBefore: boolean;
  backupFile: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  commands?: string[][];
  ownership: Ownership;
}

export interface BackupManifest {
  version: typeof MANIFEST_VERSION;
  id: string;
  kind: 'install' | 'uninstall';
  status: 'pending' | 'applied' | 'rolled_back';
  createdAt: string;
  scope: InstallScope;
  targets: HostId[];
  projectRoot: string | null;
  entries: ManifestEntry[];
}

export function installerBackupsRoot(dirs: RailDirs): string {
  return join(dirs.backups, 'host-installers');
}

export function listManifests(dirs: RailDirs): BackupManifest[] {
  const root = installerBackupsRoot(dirs);
  if (!existsSync(root)) return [];
  const manifests: BackupManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, entry.name, 'manifest.json');
    if (!entry.isDirectory() || !existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as BackupManifest;
      if (parsed.version === MANIFEST_VERSION) manifests.push(parsed);
    } catch {}
  }
  return manifests.sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt),
  );
}

export function latestInstallRecord(manifests: readonly BackupManifest[], path: string): ManifestEntry | null {
  for (let i = manifests.length - 1; i >= 0; i--) {
    const manifest = manifests[i]!;
    if (manifest.status !== 'applied') continue;
    const entry = manifest.entries.findLast((e) => e.path === path);
    if (!entry) continue;
    return manifest.kind === 'install' ? entry : null;
  }
  return null;
}

export function readBackup(record: ManifestEntry): string | null {
  return record.backupFile && existsSync(record.backupFile) ? readFileSync(record.backupFile, 'utf8') : null;
}
