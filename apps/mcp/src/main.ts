import { createCrewContext, resolveCaller } from '@crewyard/application';
import { resolveProject } from '@crewyard/projects';
import { registerWorker, unregisterWorker } from '@crewyard/storage';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createCrewMcpServer, type ExtraTool } from './server.ts';

export { createCrewMcpServer, type ExtraTool, SERVER_VERSION, TOOL_SCHEMA_VERSION } from './server.ts';

export interface RunMcpOptions {
  project?: string;
  extraTools?: readonly ExtraTool[];
}

export async function runMcpServer(options: RunMcpOptions = {}): Promise<void> {
  const ctx = createCrewContext();
  const project = await resolveProject(ctx, options.project).catch(() => null);
  const caller = resolveCaller(ctx, process.env, project?.id ?? null);
  const workerId = registerWorker(ctx.store, 'mcp', { caller: caller.kind, projectId: project?.id ?? null });
  const handle = serveStdio(() => createCrewMcpServer(ctx, caller, options.extraTools ?? []), {
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
  await runMcpServer({ ...(process.env.CREW_PROJECT ? { project: process.env.CREW_PROJECT } : {}) });
