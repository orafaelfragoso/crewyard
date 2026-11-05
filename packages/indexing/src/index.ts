export {
  type IndexOptions,
  type IndexResult,
  type IndexStats,
  indexRepository,
  type ResolvedCommit,
  resolveCommit,
} from './build.ts';
export { readLines, readText } from './content.ts';
export {
  cosine,
  createEmbeddingProvider,
  DEFAULT_OLLAMA_ENDPOINT,
  type EmbeddingProvider,
  type EmbedSnapshotInput,
  type EmbedSnapshotResult,
  embedSnapshot,
  modelKey,
  OllamaEmbeddingProvider,
  type OllamaOptions,
} from './embeddings.ts';
export {
  type IndexStatusReport,
  indexCommand,
  indexStatus,
  type ResolvedSnapshot,
  requireSnapshot,
  type SnapshotRequest,
  snapshotEnvelope,
} from './freshness.ts';
export { collectGarbage, type GarbageCollectionInput, type GarbageCollectionResult } from './gc.ts';
export {
  type DependencyGraphInput,
  type DependencyGraphResult,
  dependencyGraph,
  dependencyGraphFromSnapshot,
  type GraphDirection,
  type GraphEdge,
  type GraphNode,
  type ImportLink,
  type SnapshotModel,
  SYNTAX_NOTE,
  snapshotModel,
  traverse,
} from './graph.ts';
export type { CommandKind, DiscoveredCommand, PackageInfo, PackageKind } from './manifests.ts';
export { type RepositoryProfile, repositoryProfile } from './profile.ts';
export { classifyFile, detectLanguage, isGeneratedPath, isSecretFile, isTestPath } from './rules.ts';
export {
  compileFilter,
  type FileFilter,
  type MatchKind,
  queryTokens,
  type SearchHit,
  type SearchInput,
  type SearchMode,
  type SearchResult,
  search,
} from './search.ts';
export { DEFAULT_INDEX_CONFIG, indexRevision, snapshotByCommit } from './store.ts';
export {
  type FindReferencesInput,
  type FindReferencesResult,
  type FindSymbolInput,
  type FindSymbolResult,
  findReferences,
  findSymbol,
  type SymbolDefinition,
  type SymbolReference,
} from './symbols.ts';
export type * from './types.ts';
export {
  type VerifyInput,
  type VerifyProblem,
  type VerifyProblemKind,
  type VerifyResult,
  verifyIndex,
} from './verify.ts';
