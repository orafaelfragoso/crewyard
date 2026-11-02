#!/usr/bin/env bun
import pkg from '../../../package.json' with { type: 'json' };
import { registerAgentCommands } from './commands/agents.ts';
import { registerSystemCommands } from './commands/system.ts';
import { registerWorkCommands } from './commands/work.ts';
import { createProgram, runProgram } from './program.ts';

const program = createProgram(pkg.version);
registerSystemCommands(program, pkg.version);
registerWorkCommands(program);
registerAgentCommands(program);

process.exitCode = await runProgram(program, process.argv);
