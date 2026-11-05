import {
  analyzeImpact,
  buildContextPack,
  type ContextPack,
  fetchContextPackPage,
  type ImpactReport,
} from '@crewyard/context';
import { type Actor, CrewError } from '@crewyard/core';
import {
  acquireSnapshotReader,
  createEmbeddingProvider,
  dependencyGraph,
  findReferences,
  findSymbol,
  type GraphDirection,
  type IndexResult,
  type IndexStatusReport,
  indexRepository,
  indexRevision,
  indexStatus,
  requireSnapshot,
  resolveCommit,
  type SearchMode,
  type SearchResult,
  search,
  snapshotByCommit,
  verifyIndex,
} from '@crewyard/indexing';
import { loadProjectConfig, primaryRepository } from '@crewyard/projects';
import type { CrewContext } from '@crewyard/storage';
import { DEFAULT_EXECUTION_LIMITS, type ExecutionOperation } from './execution.ts';
import { driveExecution } from './execution-driver.ts';

export interface RevisionSelector {
  projectId: string;
  sha?: string | undefined;
  ref?: string | undefined;
  worktreePath?: string | undefined;
}

function selector(ctx: CrewContext, input: RevisionSelector) {
  const repo = primaryRepository(ctx, input.projectId);
  const config = loadProjectConfig(ctx, input.projectId).config;
  return {
    config,
    sel: {
      repositoryId: repo.id,
      ...(input.sha
        ? { sha: input.sha }
        : input.worktreePath
          ? { worktreePath: input.worktreePath }
          : { ref: input.ref ?? repo.defaultBase }),
      onDemand: true,
      config: config.index,
    },
  };
}

export async function prepareIndexExecution(
  ctx: CrewContext,
  input: RevisionSelector & { force?: boolean },
): Promise<Extract<ExecutionOperation, { kind: 'index' }>> {
  const { sel } = selector(ctx, input);
  const resolved = await resolveCommit(ctx, sel, { timeoutMs: 1_000 });
  return {
    kind: 'index',
    sha: resolved.commitSha,
    indexRevision: indexRevision(sel.config),
    force: input.force === true,
    ...(input.ref ? { ref: input.ref } : {}),
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
  };
}

export async function buildIndex(
  ctx: CrewContext,
  input: RevisionSelector & { force?: boolean; actor: Actor; indexRevision?: string; inProcess?: boolean },
): Promise<IndexResult> {
  const { sel } = selector(ctx, input);
  const revision = indexRevision(sel.config);
  if (input.indexRevision && input.indexRevision !== revision)
    throw new CrewError('CONFLICT', 'Index configuration changed after execution admission');
  if (!ctx.execution && !input.inProcess) {
    const operation = await prepareIndexExecution(ctx, input);
    const repo = primaryRepository(ctx, input.projectId);
    return (await driveExecution(
      ctx,
      {
        projectId: input.projectId,
        repositoryId: repo.id,
        actor: input.actor,
        leaderId: input.actor.id,
        operation,
      },
      { ...DEFAULT_EXECUTION_LIMITS },
    )) as unknown as IndexResult;
  }
  return indexRepository(ctx, { ...sel, ...(input.force ? { force: true } : {}), actor: input.actor });
}

export function indexState(ctx: CrewContext, input: RevisionSelector): Promise<IndexStatusReport> {
  const { sel } = selector(ctx, input);
  return indexStatus(ctx, sel);
}

export function verifyProjectIndex(ctx: CrewContext, input: RevisionSelector & { sample?: number }) {
  const { sel } = selector(ctx, input);
  return verifyIndex(ctx, { ...sel, ...(input.sample ? { sample: input.sample } : {}), markStale: true });
}

async function pinnedSelector(ctx: CrewContext, input: RevisionSelector & { inProcess?: boolean }) {
  const selected = selector(ctx, input);
  const resolved = await resolveCommit(ctx, selected.sel);
  const snapshot = snapshotByCommit(ctx.store.db, resolved.repo.id, resolved.commitSha);
  if (
    !ctx.execution &&
    (snapshot?.status !== 'available' || snapshot.revision !== indexRevision(selected.config.index))
  )
    await buildIndex(ctx, {
      projectId: input.projectId,
      sha: resolved.commitSha,
      actor: { kind: 'service', id: 'context' },
      inProcess: input.inProcess === true,
    });
  return {
    config: selected.config,
    sel: {
      ...selected.sel,
      sha: resolved.commitSha,
      onDemand: ctx.execution !== undefined || input.inProcess === true,
    },
  };
}

export interface SearchContextInput extends RevisionSelector {
  query: string;
  mode?: SearchMode;
  limit?: number;
  paths?: string[];
  excludePaths?: string[];
}

export async function searchContext(ctx: CrewContext, input: SearchContextInput): Promise<SearchResult> {
  const { sel, config } = await pinnedSelector(ctx, input);
  return search(ctx, {
    ...sel,
    query: input.query,
    mode: input.mode ?? 'hybrid',
    limit: Math.min(input.limit ?? 20, 100),
    ...(input.paths?.length ? { paths: input.paths } : {}),
    ...(input.excludePaths?.length ? { excludePaths: input.excludePaths } : {}),
    embeddingProvider: createEmbeddingProvider(config.index),
  });
}

export interface SymbolInput extends RevisionSelector {
  name: string;
  path?: string;
  references?: boolean;
  dependencies?: GraphDirection | null;
  limit?: number;
}

export async function getSymbol(ctx: CrewContext, input: SymbolInput) {
  const { sel } = await pinnedSelector(ctx, input);
  const resolved = await requireSnapshot(ctx, sel);
  const reader = acquireSnapshotReader(ctx, resolved.snapshot);
  try {
    const limit = Math.min(input.limit ?? 50, 200);
    const definitions = await findSymbol(ctx, {
      ...sel,
      name: input.name,
      ...(input.path ? { path: input.path } : {}),
      limit,
    });
    const references =
      input.references === false
        ? null
        : await findReferences(ctx, {
            ...sel,
            name: input.name,
            ...(input.path ? { definitionPath: input.path } : {}),
            limit,
          });
    const definitionPaths = [...new Set(definitions.definitions.map((d) => d.path))];
    const graph =
      input.dependencies && definitionPaths.length > 0
        ? await dependencyGraph(ctx, { ...sel, paths: definitionPaths, direction: input.dependencies, depth: 2, limit })
        : null;
    return { definitions, references, graph };
  } finally {
    reader.release();
  }
}

export async function impact(
  ctx: CrewContext,
  input: RevisionSelector & {
    paths?: string[];
    symbols?: string[];
    excludeTaskId?: string;
    depth?: number;
    inProcess?: boolean;
  },
): Promise<ImpactReport> {
  const { sel } = await pinnedSelector(ctx, input);
  return analyzeImpact(ctx, {
    ...sel,
    ...(input.paths ? { paths: input.paths } : {}),
    ...(input.symbols ? { symbols: input.symbols } : {}),
    ...(input.excludeTaskId ? { excludeTaskId: input.excludeTaskId } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
    persist: true,
  });
}

export async function contextPack(
  ctx: CrewContext,
  input: RevisionSelector & { query: string; paths?: string[]; symbols?: string[]; budgetTokens?: number },
): Promise<ContextPack> {
  const { sel, config } = await pinnedSelector(ctx, input);
  return buildContextPack(ctx, {
    ...sel,
    query: input.query,
    scope: { ...(input.paths ? { paths: input.paths } : {}), ...(input.symbols ? { symbols: input.symbols } : {}) },
    budgetTokens: input.budgetTokens ?? config.index.max_context_tokens,
    embeddingProvider: createEmbeddingProvider(config.index),
  });
}

export function contextPackPage(ctx: CrewContext, cursor: string, budgetTokens?: number) {
  return fetchContextPackPage(ctx, { cursor, ...(budgetTokens ? { budgetTokens } : {}) });
}
