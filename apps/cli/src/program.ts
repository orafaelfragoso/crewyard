import { userInfo } from 'node:os';
import { createCrewContext } from '@crewyard/application';
import type { Actor } from '@crewyard/core';
import { type CrewContext, previewStore } from '@crewyard/storage';
import { Command, CommanderError, Option } from 'commander';
import { confirm, type GlobalOptions, reportError } from './output.ts';

let shared: CrewContext | null = null;

export function crewContext(): CrewContext {
  shared ??= createCrewContext();
  return shared;
}

export function closeContext(): void {
  shared?.store.close();
  shared = null;
}

export function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

export type Action<A extends unknown[]> = (
  ctx: CrewContext,
  opts: GlobalOptions & Record<string, unknown>,
  ...args: A
) => Promise<void> | void;

export function action<A extends unknown[]>(fn: Action<A>) {
  return async (...raw: unknown[]) => {
    const command = raw.at(-1) as Command;
    const positional = raw.slice(0, command.registeredArguments.length) as A;
    const opts = { ...command.optsWithGlobals<GlobalOptions & Record<string, unknown>>() };
    await fn(crewContext(), opts, ...positional);
  };
}

export function withMutationOptions(command: Command): Command {
  return command
    .addOption(new Option('--dry-run', 'preview the change without applying it'))
    .addOption(new Option('-y, --yes', 'confirm destructive or authorization-gated actions'));
}

export function withConfirmOption(command: Command): Command {
  return command.addOption(new Option('-y, --yes', 'confirm destructive or authorization-gated actions'));
}

export function previewContext(ctx: CrewContext): CrewContext {
  return { ...ctx, store: previewStore(ctx.store) };
}

export async function mutate<T>(
  ctx: CrewContext,
  opts: GlobalOptions,
  question: string,
  apply: (ctx: CrewContext) => T,
): Promise<T> {
  if (opts.dryRun) return apply(previewContext(ctx));
  await confirm(opts, question);
  return apply(ctx);
}

export function createProgram(version: string): Command {
  const program = new Command('crew')
    .description('Crewyard — coordinate independent AI coding agents working in the same repositories')
    .version(version, '-V, --version-flag', 'print the version')
    .option('--json', 'machine-readable output (a single JSON object or JSONL stream)')
    .option('--project <name>', 'project name or id (default: the project of the current directory)')
    .showHelpAfterError()
    .exitOverride();
  program.configureOutput({
    writeOut: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  });
  return program;
}

export async function runProgram(program: Command, argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version' || error.exitCode === 0)
        return 0;
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: error.message, retryable: false } })}\n`,
        );
      }
      return 2;
    }
    return reportError(error, json);
  } finally {
    closeContext();
  }
}

export function operatorActor(): Actor {
  return { kind: 'operator', id: process.env.CREW_OPERATOR ?? userInfo().username };
}
