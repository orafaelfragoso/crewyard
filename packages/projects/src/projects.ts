import { basename } from 'node:path';
import { type CrewConfig, type LoadedConfig, loadConfig } from '@crewyard/config';
import {
  type Actor,
  type AutonomyMode,
  CrewError,
  canonicalPath,
  fingerprint,
  isGitRepository,
  newId,
  nowIso,
  remoteIdentity,
  repositoryRoot,
} from '@crewyard/core';
import { all, type CrewContext, one, parseJson, recordTransition } from '@crewyard/storage';

export interface Project {
  id: string;
  name: string;
  configPath: string | null;
  autonomy: AutonomyMode;
  intakePaused: boolean;
  workersPaused: boolean;
  policyRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  projectId: string;
  canonicalPath: string;
  remoteUrl: string | null;
  remoteHost: string | null;
  remoteOwner: string | null;
  remoteName: string | null;
  hostKind: string;
  defaultBase: string;
  indexCoverage: Record<string, unknown> | null;
  contentFingerprint: string | null;
  ghConfigDir: string | null;
  trusted: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  config_path: string | null;
  autonomy: AutonomyMode;
  intake_paused: number;
  workers_paused: number;
  policy_revision: number;
  created_at: string;
  updated_at: string;
}

interface RepositoryRow {
  id: string;
  project_id: string;
  canonical_path: string;
  remote_url: string | null;
  remote_host: string | null;
  remote_owner: string | null;
  remote_name: string | null;
  host_kind: string;
  default_base: string;
  index_coverage: string | null;
  content_fingerprint: string | null;
  gh_config_dir: string | null;
  trusted: number;
}

export const mapProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  configPath: r.config_path,
  autonomy: r.autonomy,
  intakePaused: r.intake_paused === 1,
  workersPaused: r.workers_paused === 1,
  policyRevision: r.policy_revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapRepository = (r: RepositoryRow): Repository => ({
  id: r.id,
  projectId: r.project_id,
  canonicalPath: r.canonical_path,
  remoteUrl: r.remote_url,
  remoteHost: r.remote_host,
  remoteOwner: r.remote_owner,
  remoteName: r.remote_name,
  hostKind: r.host_kind,
  defaultBase: r.default_base,
  indexCoverage: parseJson(r.index_coverage, null),
  contentFingerprint: r.content_fingerprint,
  ghConfigDir: r.gh_config_dir,
  trusted: r.trusted === 1,
});

export function getProject(ctx: CrewContext, idOrName: string): Project {
  const row = one<ProjectRow>(ctx.store.db, 'SELECT * FROM projects WHERE id = ? OR name = ?', idOrName, idOrName);
  if (!row) {
    throw new CrewError('NOT_FOUND', `Project not found: ${idOrName}`, {
      suggestion: 'Run `crew project list` or `crew init` in the repository.',
    });
  }
  return mapProject(row);
}

export function listProjects(ctx: CrewContext): Project[] {
  return all<ProjectRow>(ctx.store.db, 'SELECT * FROM projects ORDER BY name').map(mapProject);
}

export function listRepositories(ctx: CrewContext, projectId?: string): Repository[] {
  return (
    projectId
      ? all<RepositoryRow>(
          ctx.store.db,
          'SELECT * FROM repositories WHERE project_id = ? ORDER BY canonical_path',
          projectId,
        )
      : all<RepositoryRow>(ctx.store.db, 'SELECT * FROM repositories ORDER BY canonical_path')
  ).map(mapRepository);
}

export function getRepository(ctx: CrewContext, id: string): Repository {
  const row = one<RepositoryRow>(ctx.store.db, 'SELECT * FROM repositories WHERE id = ?', id);
  if (!row) throw new CrewError('NOT_FOUND', `Repository not found: ${id}`);
  return mapRepository(row);
}

export function primaryRepository(ctx: CrewContext, projectId: string): Repository {
  const repos = listRepositories(ctx, projectId);
  if (repos.length === 0) {
    throw new CrewError('NOT_FOUND', `Project ${projectId} has no repositories`, {
      suggestion: 'Run `crew init --repo PATH`.',
    });
  }
  return repos[0]!;
}

export async function findProjectForPath(ctx: CrewContext, cwd: string): Promise<Project | null> {
  if (!(await isGitRepository(cwd))) return null;
  const root = canonicalPath(await repositoryRoot(cwd));
  const repo = one<RepositoryRow>(ctx.store.db, 'SELECT * FROM repositories WHERE canonical_path = ?', root);
  if (repo) return getProject(ctx, repo.project_id);
  const common = (
    await Bun.$`git -C ${cwd} rev-parse --path-format=absolute --git-common-dir`.quiet().nothrow().text()
  ).trim();
  if (common) {
    const mainRoot = canonicalPath(common.replace(/[\\/]\.git$/, ''));
    const mainRepo = one<RepositoryRow>(ctx.store.db, 'SELECT * FROM repositories WHERE canonical_path = ?', mainRoot);
    if (mainRepo) return getProject(ctx, mainRepo.project_id);
  }
  return null;
}

export async function resolveProject(
  ctx: CrewContext,
  selector: string | undefined,
  cwd: string = process.cwd(),
): Promise<Project> {
  if (selector && selector !== 'current') return getProject(ctx, selector);
  const found = await findProjectForPath(ctx, cwd);
  if (found) return found;
  const names = listProjects(ctx).map((p) => p.name);
  throw new CrewError('NOT_FOUND', `${cwd} is not inside a Crewyard project`, {
    details: { cwd, projects: names },
    suggestion: names.length
      ? `Run this inside a registered repository, or pass --project <name> (registered: ${names.join(', ')}).`
      : 'Run `crew init --repo .` inside your repository first.',
  });
}

export function loadProjectConfig(ctx: CrewContext, projectId: string, flags?: Record<string, unknown>): LoadedConfig {
  const project = getProject(ctx, projectId);
  const repo = primaryRepository(ctx, project.id);
  return loadConfig({
    repoRoot: repo.canonicalPath,
    dirs: ctx.dirs,
    flags: flags ?? {},
    projectNameFallback: project.name,
  });
}

export function projectConfig(ctx: CrewContext, projectId: string): CrewConfig {
  return loadProjectConfig(ctx, projectId).config;
}

export interface RegisterProjectInput {
  repoPath: string;
  name?: string;
  baseBranch: string;
  autonomy?: AutonomyMode;
  configPath?: string | null;
  ghConfigDir?: string | null;
  actor: Actor;
}

export async function registerProject(
  ctx: CrewContext,
  input: RegisterProjectInput,
): Promise<{ project: Project; repository: Repository; created: boolean }> {
  if (!(await isGitRepository(input.repoPath))) {
    throw new CrewError('INVALID_INPUT', `${input.repoPath} is not a Git working tree`, {
      suggestion: 'Run inside a Git repository.',
    });
  }
  const root = canonicalPath(await repositoryRoot(input.repoPath));
  const remote = await remoteIdentity(root);
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const existing = one<RepositoryRow>(db, 'SELECT * FROM repositories WHERE canonical_path = ?', root);
    if (existing) {
      db.query(
        'UPDATE repositories SET remote_url = ?, remote_host = ?, remote_owner = ?, remote_name = ?, default_base = ?, updated_at = ? WHERE id = ?',
      ).run(
        remote?.url ?? null,
        remote?.host ?? null,
        remote?.owner ?? null,
        remote?.name ?? null,
        input.baseBranch,
        at,
        existing.id,
      );
      const project = mapProject(one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', existing.project_id)!);
      const repository = mapRepository(one<RepositoryRow>(db, 'SELECT * FROM repositories WHERE id = ?', existing.id)!);
      return { project, repository, created: false };
    }
    const name = input.name ?? basename(root);
    if (one(db, 'SELECT id FROM projects WHERE name = ?', name)) {
      throw new CrewError('CONFLICT', `A project named ${name} already exists`, {
        suggestion: 'Pass --name to choose another name.',
      });
    }
    const projectId = newId('prj');
    const repoId = newId('repo');
    db.query(
      'INSERT INTO projects (id, name, config_path, autonomy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(projectId, name, input.configPath ?? null, input.autonomy ?? 'guarded', at, at);
    db.query(
      `INSERT INTO repositories (id, project_id, canonical_path, remote_url, remote_host, remote_owner, remote_name, default_base, gh_config_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repoId,
      projectId,
      root,
      remote?.url ?? null,
      remote?.host ?? null,
      remote?.owner ?? null,
      remote?.name ?? null,
      input.baseBranch,
      input.ghConfigDir ?? null,
      at,
      at,
    );
    recordTransition(
      db,
      {
        type: 'project.registered',
        actor: input.actor,
        projectId,
        payload: { name, repository: root, baseBranch: input.baseBranch },
      },
      { action: 'project.register', input: { name, root }, decision: 'accepted' },
      at,
    );
    return {
      project: mapProject(one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId)!),
      repository: mapRepository(one<RepositoryRow>(db, 'SELECT * FROM repositories WHERE id = ?', repoId)!),
      created: true,
    };
  });
}

export function setProjectFlags(
  ctx: CrewContext,
  projectId: string,
  flags: { intakePaused?: boolean; workersPaused?: boolean; autonomy?: AutonomyMode },
  actor: Actor,
): Project {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const current = mapProject(one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId)!);
    db.query(
      'UPDATE projects SET intake_paused = ?, workers_paused = ?, autonomy = ?, updated_at = ? WHERE id = ?',
    ).run(
      (flags.intakePaused ?? current.intakePaused) ? 1 : 0,
      (flags.workersPaused ?? current.workersPaused) ? 1 : 0,
      flags.autonomy ?? current.autonomy,
      at,
      projectId,
    );
    recordTransition(
      db,
      { type: 'project.flags_changed', actor, projectId, payload: { ...flags } },
      { action: 'project.set_flags', input: flags, decision: 'accepted', policyRevision: current.policyRevision },
      at,
    );
    return mapProject(one<ProjectRow>(db, 'SELECT * FROM projects WHERE id = ?', projectId)!);
  });
}

export function recordPolicyRevision(ctx: CrewContext, projectId: string, config: CrewConfig, author: string): number {
  const body = JSON.stringify(config);
  const bodyFingerprint = fingerprint(config);
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    let policy = one<{ id: string; current_revision: number }>(
      db,
      `SELECT id, current_revision FROM policies WHERE project_id = ? AND name = 'repository-config'`,
      projectId,
    );
    if (!policy) {
      const id = newId('pol');
      db.query(
        `INSERT INTO policies (id, project_id, name, current_revision, created_at) VALUES (?, ?, 'repository-config', 0, ?)`,
      ).run(id, projectId, at);
      policy = { id, current_revision: 0 };
    }
    const latest = one<{ body_fingerprint: string }>(
      db,
      'SELECT body_fingerprint FROM policy_revisions WHERE policy_id = ? AND revision = ?',
      policy.id,
      policy.current_revision,
    );
    if (latest?.body_fingerprint === bodyFingerprint) return policy.current_revision;
    const revision = policy.current_revision + 1;
    db.query(
      'INSERT INTO policy_revisions (policy_id, revision, body, body_fingerprint, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(policy.id, revision, body, bodyFingerprint, author, at);
    db.query('UPDATE policies SET current_revision = ? WHERE id = ?').run(revision, policy.id);
    db.query(
      'UPDATE projects SET policy_revision = ?, autonomy = ?, config_snapshot = ?, updated_at = ? WHERE id = ?',
    ).run(revision, config.project.autonomy, body, at, projectId);
    return revision;
  });
}

export function setRepositoryTrust(ctx: CrewContext, repositoryId: string, trusted: boolean, actor: Actor): void {
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    const repo = mapRepository(one<RepositoryRow>(db, 'SELECT * FROM repositories WHERE id = ?', repositoryId)!);
    db.query('UPDATE repositories SET trusted = ?, updated_at = ? WHERE id = ?').run(trusted ? 1 : 0, at, repositoryId);
    recordTransition(
      db,
      { type: 'repository.trust_changed', actor, projectId: repo.projectId, payload: { repositoryId, trusted } },
      { action: 'repository.set_trust', input: { repositoryId, trusted }, decision: 'accepted' },
      at,
    );
  });
}
