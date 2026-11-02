import {
  analyzeImpact,
  buildContextPack,
  type ContextPack,
  fetchContextPackPage,
  type ImpactReport,
} from '@crewyard/context';
import type { Actor } from '@crewyard/core';
import {
  createEmbeddingProvider,
  dependencyGraph,
  findReferences,
  findSymbol,
  type GraphDirection,
  type IndexResult,
  type IndexStatusReport,
  indexRepository,
  indexStatus,
  type SearchMode,
  type SearchResult,
  search,
  verifyIndex,
} from '@crewyard/indexing';
import { loadProjectConfig, primaryRepository } from '@crewyard/projects';
import type { CrewContext } from '@crewyard/storage';

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

export async function buildIndex(
  ctx: CrewContext,
  input: RevisionSelector & { force?: boolean; actor: Actor },
): Promise<IndexResult> {
  const { sel } = selector(ctx, input);
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

export interface SearchContextInput extends RevisionSelector {
  query: string;
  mode?: SearchMode;
  limit?: number;
  paths?: string[];
  excludePaths?: string[];
}

export function searchContext(ctx: CrewContext, input: SearchContextInput): Promise<SearchResult> {
  const { sel, config } = selector(ctx, input);
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
  const { sel } = selector(ctx, input);
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
}

export function impact(
  ctx: CrewContext,
  input: RevisionSelector & { paths?: string[]; symbols?: string[]; excludeTaskId?: string; depth?: number },
): Promise<ImpactReport> {
  const { sel } = selector(ctx, input);
  return analyzeImpact(ctx, {
    ...sel,
    ...(input.paths ? { paths: input.paths } : {}),
    ...(input.symbols ? { symbols: input.symbols } : {}),
    ...(input.excludeTaskId ? { excludeTaskId: input.excludeTaskId } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
    persist: true,
  });
}

export function contextPack(
  ctx: CrewContext,
  input: RevisionSelector & { query: string; paths?: string[]; symbols?: string[]; budgetTokens?: number },
): Promise<ContextPack> {
  const { sel, config } = selector(ctx, input);
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
