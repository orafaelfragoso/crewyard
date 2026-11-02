#!/usr/bin/env bun
// Fake coding agent for Crewyard tests. Speaks the generic JSONL protocol v1 (docs/provider-adapters/generic.md).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Options {
  events: number;
  delayMs: number;
  usage: { input: number; output: number; cost: number | null } | null;
  sleepMs: number;
  exitCode: number;
  error: string | null;
  errorClass: string | null;
  stderr: string[];
  writes: [string, string][];
  spawnChildPidFile: string | null;
  ignoreSigterm: boolean;
  echoEnv: string[];
  dumpEnv: [string, string][];
  sessionId: string | null;
  result: string | null;
  text: boolean;
  readyFile: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    events: 1,
    delayMs: 0,
    usage: null,
    sleepMs: 0,
    exitCode: 0,
    error: null,
    errorClass: null,
    stderr: [],
    writes: [],
    spawnChildPidFile: null,
    ignoreSigterm: false,
    echoEnv: [],
    dumpEnv: [],
    sessionId: null,
    result: null,
    text: false,
    readyFile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i] ?? '';
    switch (flag) {
      case '--events':
        options.events = Number(next());
        break;
      case '--delay':
        options.delayMs = Number(next());
        break;
      case '--usage': {
        const [input, output, cost] = next().split(',').map(Number);
        options.usage = { input: input ?? 0, output: output ?? 0, cost: cost === undefined ? null : cost };
        break;
      }
      case '--sleep':
        options.sleepMs = Number(next());
        break;
      case '--exit':
        options.exitCode = Number(next());
        break;
      case '--error':
        options.error = next();
        break;
      case '--error-class':
        options.errorClass = next();
        break;
      case '--stderr':
        options.stderr.push(next());
        break;
      case '--write': {
        const spec = next();
        const eq = spec.indexOf('=');
        options.writes.push([spec.slice(0, eq), spec.slice(eq + 1)]);
        break;
      }
      case '--spawn-child':
        options.spawnChildPidFile = next();
        break;
      case '--ignore-sigterm':
        options.ignoreSigterm = true;
        break;
      case '--echo-env':
        options.echoEnv.push(next());
        break;
      case '--dump-env': {
        const spec = next();
        const eq = spec.indexOf('=');
        options.dumpEnv.push([spec.slice(0, eq), spec.slice(eq + 1)]);
        break;
      }
      case '--session':
        options.sessionId = next();
        break;
      case '--result':
        options.result = next();
        break;
      case '--text':
        options.text = true;
        break;
      case '--ready':
        options.readyFile = next();
        break;
    }
  }
  return options;
}

const prompt = process.stdin.isTTY ? '' : await new Response(Bun.stdin.stream()).text();
const directive = /^FAKE:(.*)$/m.exec(prompt)?.[1]?.trim() ?? '';
const directiveArgs: string[] = directive.startsWith('[')
  ? (JSON.parse(directive) as string[])
  : directive
    ? directive.split(/\s+/)
    : [];
const options = parseArgs([...process.argv.slice(2), ...directiveArgs]);
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const say = (text: string) =>
  options.text ? process.stdout.write(`${text}\n`) : emit({ type: 'message', role: 'assistant', text });

if (options.ignoreSigterm) process.on('SIGTERM', () => {});

if (options.spawnChildPidFile) {
  const child = Bun.spawn([process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  writeFileSync(options.spawnChildPidFile, String(child.pid));
}
if (options.readyFile) writeFileSync(options.readyFile, String(process.pid));

if (!options.text) emit({ type: 'session', id: options.sessionId ?? `fake-${process.pid}` });
say(`received ${prompt.length} prompt characters`);
for (const name of options.echoEnv) say(`${name}=${process.env[name] ?? ''}`);
for (const [name, path] of options.dumpEnv) writeFileSync(path, process.env[name] ?? '');
for (const line of options.stderr) process.stderr.write(`${line}\n`);
for (const [path, content] of options.writes) {
  if (!options.text) emit({ type: 'tool', name: 'write_file', status: 'started', detail: path });
  writeFileSync(join(process.cwd(), path), content);
  if (!options.text) emit({ type: 'tool', name: 'write_file', status: 'completed', detail: path });
}
for (let i = 0; i < options.events; i++) {
  say(`progress ${i + 1}/${options.events}`);
  if (options.delayMs > 0) await Bun.sleep(options.delayMs);
}
if (options.sleepMs > 0) await Bun.sleep(options.sleepMs);
if (options.usage && !options.text) {
  emit({
    type: 'usage',
    input_tokens: options.usage.input,
    output_tokens: options.usage.output,
    ...(options.usage.cost === null ? {} : { cost_usd: options.usage.cost }),
    model: process.env.CREW_MODEL ?? 'fake-model',
  });
}
if (options.error && !options.text) {
  emit({ type: 'error', message: options.error, ...(options.errorClass ? { class: options.errorClass } : {}) });
}
if (options.result && !options.text) emit({ type: 'result', text: options.result });
process.exit(options.exitCode);
