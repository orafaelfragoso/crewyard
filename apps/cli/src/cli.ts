import type { Command } from 'commander';
import pkg from '../../../package.json' with { type: 'json' };
import { registerAgentCommands } from './commands/agents.ts';
import { registerDashboardCommand } from './commands/dashboard.ts';
import { registerInstallCommands } from './commands/install.ts';
import { registerIntegrationCommands } from './commands/integration.ts';
import { registerMaintenanceCommands } from './commands/maintenance.ts';
import { registerServiceCommands } from './commands/service.ts';
import { registerSystemCommands } from './commands/system.ts';
import { registerWorkCommands } from './commands/work.ts';
import { createProgram } from './program.ts';

export const VERSION: string = pkg.version;

export function buildProgram(): Command {
  const program = createProgram(VERSION);
  registerSystemCommands(program, VERSION);
  registerWorkCommands(program);
  registerAgentCommands(program);
  registerInstallCommands(program);
  registerServiceCommands(program);
  registerDashboardCommand(program);
  registerIntegrationCommands(program);
  registerMaintenanceCommands(program);
  program
    .command('mcp')
    .description('run the MCP stdio server (stdout carries protocol messages only)')
    .action(async () => {
      const { runMcpServer } = await import('@crewyard/mcp');
      const project = program.opts<{ project?: string }>().project ?? process.env.CREW_PROJECT;
      await runMcpServer(project ? { project } : {});
    });
  return program;
}
