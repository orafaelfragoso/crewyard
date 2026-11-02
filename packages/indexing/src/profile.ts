import type { CrewContext } from '@crewyard/storage';
import { requireSnapshot, type SnapshotRequest } from './freshness.ts';
import { snapshotModel } from './graph.ts';
import { type DiscoveredCommand, discoverCommands, type PackageInfo } from './manifests.ts';
import type { ResultEnvelope } from './types.ts';

export interface RepositoryProfile extends ResultEnvelope {
  fileCount: number;
  languages: Record<string, number>;
  kinds: Record<string, number>;
  packages: PackageInfo[];
  workspaceRoots: string[];
  docs: string[];
  workflows: string[];
  testFileCount: number;
  testDirectories: string[];
  commands: DiscoveredCommand[];
}

export async function repositoryProfile(ctx: CrewContext, request: SnapshotRequest): Promise<RepositoryProfile> {
  const { snapshot, envelope } = await requireSnapshot(ctx, request);
  const model = snapshotModel(ctx.store, snapshot);
  const languages: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const docs: string[] = [];
  const workflows: string[] = [];
  const testDirs = new Set<string>();
  let tests = 0;
  for (const f of model.files) {
    if (f.language) languages[f.language] = (languages[f.language] ?? 0) + 1;
    kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    if (f.kind === 'workflow') workflows.push(f.path);
    if (f.kind === 'doc' && (/(^|\/)readme(\.|$)/i.test(f.path) || f.path.startsWith('docs/'))) docs.push(f.path);
    if (f.kind === 'test') {
      tests++;
      const dir = /^(.*?(?:^|\/)(?:tests?|__tests__|spec|e2e))\//.exec(f.path)?.[1];
      if (dir) testDirs.add(dir);
    }
  }
  return {
    ...envelope,
    fileCount: model.files.length,
    languages,
    kinds,
    packages: model.packages,
    workspaceRoots: model.packages.filter((p) => p.workspaceMembers.length > 0).map((p) => p.root),
    docs: docs.slice(0, 200),
    workflows,
    testFileCount: tests,
    testDirectories: [...testDirs].sort().slice(0, 100),
    commands: discoverCommands(ctx.store.db, model.files, model.packages),
  };
}
