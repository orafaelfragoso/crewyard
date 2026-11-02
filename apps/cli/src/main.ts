#!/usr/bin/env bun
import { buildProgram } from './cli.ts';
import { runProgram } from './program.ts';

process.exitCode = await runProgram(buildProgram(), process.argv);
