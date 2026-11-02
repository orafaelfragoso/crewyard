import { createRailContext, resolveCaller } from '@agent-rail/application';
import { resolveProject } from '@agent-rail/projects';
import { registerWorker, unregisterWorker } from '@agent-rail/storage';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRailMcpServer, type ExtraTool } from './server.ts';

export { createRailMcpServer, type ExtraTool, SERVER_VERSION, TOOL_SCHEMA_VERSION } from './server.ts';

export interface RunMcpOptions {
  project?: string;
  extraTools?: readonly ExtraTool[];
}

export async function runMcpServer(options: RunMcpOptions = {}): Promise<void> {
  const ctx = createRailContext();
  const project = await resolveProject(ctx, options.project).catch(() => null);
  const caller = resolveCaller(ctx, process.env, project?.id ?? null);
  const workerId = registerWorker(ctx.store, 'mcp', { caller: caller.kind, projectId: project?.id ?? null });
  const handle = serveStdio(() => createRailMcpServer(ctx, caller, options.extraTools ?? []), {
    onerror: (error) => ctx.logger.error('mcp transport error', { error: error.message }),
  });
  const shutdown = async () => {
    await handle.close();
    unregisterWorker(ctx.store, workerId);
    ctx.store.close();
  };
  process.stdin.once('end', () => void shutdown());
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
}

if (import.meta.main)
  await runMcpServer({ ...(process.env.RAIL_PROJECT ? { project: process.env.RAIL_PROJECT } : {}) });
