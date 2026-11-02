export interface ContextHit {
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  score: number;
  snippet: string;
  symbol: string | null;
  indexStatus: string;
}

export interface ContextSearchResult {
  hits: ContextHit[];
  commitSha: string | null;
  retrievedAt: string;
  tokenEstimate: number;
  warnings: string[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface DashboardActions {
  pauseProject(projectId: string, paused: boolean): Promise<ActionResult>;
  pauseWorkers(projectId: string, paused: boolean): Promise<ActionResult>;
  retryTask(taskId: string, reason: string): Promise<ActionResult>;
  escalateTask(taskId: string, reason: string): Promise<ActionResult>;
  cancelSession(sessionId: string): Promise<ActionResult>;
  approveTask(taskId: string): Promise<ActionResult>;
  retryQueueEntry(entryId: string, reason: string): Promise<ActionResult>;
  escalateQueueEntry(entryId: string, reason: string): Promise<ActionResult>;
  openUrl(url: string): Promise<ActionResult>;
  exportDiagnostics(): Promise<ActionResult>;
  searchContext(projectId: string, query: string): Promise<ContextSearchResult>;
  inspectTask(taskId: string): Promise<Record<string, unknown>>;
}
