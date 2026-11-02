#!/usr/bin/env bun
import pkg from '../../../package.json' with { type: 'json' };
import { registerSystemCommands } from './commands/system.ts';
import { createProgram, runProgram } from './program.ts';

const program = createProgram(pkg.version);
registerSystemCommands(program, pkg.version);

process.exitCode = await runProgram(program, process.argv);
