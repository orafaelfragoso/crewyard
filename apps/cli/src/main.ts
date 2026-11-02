#!/usr/bin/env bun
import pkg from '../../../package.json' with { type: 'json' };
import { registerAgentCommands } from './commands/agents.ts';
import { registerInstallCommands } from './commands/install.ts';
import { registerSystemCommands } from './commands/system.ts';
import { registerWorkCommands } from './commands/work.ts';
import { createProgram, runProgram } from './program.ts';

const program = createProgram(pkg.version);
registerSystemCommands(program, pkg.version);
registerWorkCommands(program);
registerAgentCommands(program);
registerInstallCommands(program);

program
  .command('mcp')
  .description('run the MCP stdio server (stdout carries protocol messages only)')
  .action(async () => {
    const { runMcpServer } = await import('@agent-rail/mcp');
    const project = program.opts<{ project?: string }>().project ?? process.env.RAIL_PROJECT;
    await runMcpServer(project ? { project } : {});
  });

process.exitCode = await runProgram(program, process.argv);
