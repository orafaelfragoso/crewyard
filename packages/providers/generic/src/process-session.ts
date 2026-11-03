import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  CrewError,
  type FailureClass,
  isSecretKeyName,
  killTree,
  nowIso,
  REDACTED,
  redact,
  type SessionOutcome,
  type UsageReport,
  waitForGroupExit,
} from '@crewyard/core';
import { createChannel } from './channel.ts';
import { classifyFailureText } from './classify.ts';

export interface DecoderSummary {
  usage: UsageReport;
  result: string | null;
  failure: { message: string; classification: FailureClass } | null;
}

export interface StreamDecoder {
  line(text: string, at: string): AgentEvent[];
  summary(): DecoderSummary;
}

export interface ProcessLaunchSpec {
  argv: string[];
  env: Record<string, string>;
  stdin?: string | null;
  decoder: StreamDecoder;
  secretValues?: string[];
}

export interface ProcessSessionOptions {
  cancelGraceMs?: number;
}

export type SessionResult = Awaited<AgentSessionHandle['done']>;

const STDERR_TAIL_BYTES = 8 * 1024;
const MAX_EVENT_TEXT = 4_000;
const DRAIN_AFTER_EXIT_MS = 2_000;
const MIN_SECRET_LENGTH = 8;

export function collectSecretValues(env: Record<string, string>, extra: readonly (string | null | undefined)[] = []) {
  const values = Object.entries(env)
    .filter(([key]) => isSecretKeyName(key))
    .map(([, value]) => value);
  return [...values, ...extra].filter((v): v is string => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH);
}

export function createRedactor(secretValues: readonly string[]): (text: string) => string {
  const secrets = [...new Set(secretValues.filter((v) => v.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => {
    let out = text;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    return redact(out);
  };
}

export function redactEvent(event: AgentEvent, scrub: (text: string) => string): AgentEvent {
  switch (event.type) {
    case 'message':
      return { ...event, text: scrub(event.text) };
    case 'log':
      return { ...event, text: scrub(event.text) };
    case 'error':
      return { ...event, message: scrub(event.message) };
    case 'tool':
      return event.detail === undefined ? event : { ...event, detail: scrub(event.detail) };
    case 'completed':
      return event.result === undefined ? event : { ...event, result: scrub(event.result) };
    default:
      return event;
  }
}

class LogSink {
  private fd: number | null;
  constructor(
    path: string,
    private readonly scrub: (text: string) => string,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, 'a', 0o600);
  }
  write(stream: 'stdout' | 'stderr' | 'crew', text: string): void {
    if (this.fd === null) return;
    const prefix = stream === 'stdout' ? '' : `[${stream}] `;
    writeSync(this.fd, `${prefix}${this.scrub(text)}\n`);
  }
  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  onBytes: (bytes: number) => boolean,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!onBytes(value.byteLength)) continue;
      pending += decoder.decode(value, { stream: true });
      let index = pending.indexOf('\n');
      while (index >= 0) {
        onLine(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) onLine(pending);
  } catch {
    // stream cancelled after exit or by abort
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function killProcessGroup(pid: number): void {
  if (process.platform === 'win32') {
    killTree(pid, 'SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // the process group has already exited
  }
}

interface Running {
  pid: number;
  cancel(): Promise<void>;
}

export class ProcessSessions {
  private readonly running = new Map<string, Running>();
  private readonly cancelGraceMs: number;

  constructor(options: ProcessSessionOptions = {}) {
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000;
  }

  has(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    await this.running.get(sessionId)?.cancel();
  }

  async launch(input: AgentLaunch, spec: ProcessLaunchSpec): Promise<AgentSessionHandle> {
    if (this.running.has(input.sessionId)) {
      throw new CrewError('CONFLICT', `Session ${input.sessionId} is already running`);
    }
    const scrub = createRedactor([...(spec.secretValues ?? []), ...collectSecretValues(spec.env)]);
    const log = new LogSink(input.logPath, scrub);
    const channel = createChannel<AgentEvent>();
    let proc: Bun.Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>;
    try {
      proc = Bun.spawn(spec.argv, {
        cwd: input.cwd,
        env: spec.env,
        stdin: spec.stdin == null ? 'ignore' : 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      log.write('crew', `spawn failed: ${(error as Error).message}`);
      log.close();
      throw new CrewError('UNAVAILABLE', `Cannot execute ${spec.argv[0]}: ${(error as Error).message}`, {
        cause: error,
        suggestion: `Install ${spec.argv[0]} or set the profile's executable path.`,
      });
    }
    const pid = proc.pid;
    if (spec.stdin != null && proc.stdin && typeof proc.stdin !== 'number') {
      try {
        proc.stdin.write(spec.stdin);
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch (error) {
        log.write('crew', `stdin write failed: ${(error as Error).message}`);
      }
    }

    let errorEmitted = false;
    let cancelRequested = false;
    let timedOut = false;
    let limitExceeded = false;
    let outputBytes = 0;
    let stderrTail = '';

    const emit = (event: AgentEvent) => {
      const safe = redactEvent(event, scrub);
      if (safe.type === 'started') channel.push({ ...safe, pid });
      else channel.push(safe);
      if (safe.type === 'error') errorEmitted = true;
    };

    const graceKill = async (graceMs: number) => {
      killTree(pid, 'SIGTERM');
      const deadline = Date.now() + graceMs;
      while (proc.exitCode === null && proc.signalCode === null && Date.now() < deadline) await Bun.sleep(50);
      killProcessGroup(pid);
      await waitForGroupExit(pid, 2_000);
    };

    const countBytes = (bytes: number): boolean => {
      if (limitExceeded) return false;
      outputBytes += bytes;
      if (outputBytes <= input.maxOutputBytes) return true;
      limitExceeded = true;
      emit({
        type: 'error',
        at: nowIso(),
        message: `Output exceeded the ${input.maxOutputBytes} byte limit; terminating session`,
        classification: 'policy_violation',
      });
      void graceKill(this.cancelGraceMs);
      return false;
    };

    emit({ type: 'started', at: nowIso(), pid });
    log.write('crew', `started pid=${pid} argv0=${spec.argv[0]}`);

    const timer = setTimeout(() => {
      timedOut = true;
      emit({
        type: 'error',
        at: nowIso(),
        message: `Session exceeded its ${input.timeoutMs} ms timeout`,
        classification: 'unknown',
      });
      void graceKill(this.cancelGraceMs);
    }, input.timeoutMs);

    const drain = new AbortController();
    const stdoutDone = readLines(
      proc.stdout,
      (line) => {
        log.write('stdout', line);
        if (line.trim() === '') return;
        for (const event of spec.decoder.line(line, nowIso())) emit(event);
      },
      countBytes,
      drain.signal,
    );
    const stderrDone = readLines(
      proc.stderr,
      (line) => {
        log.write('stderr', line);
        if (line.trim() === '') return;
        stderrTail = `${stderrTail}${line}\n`.slice(-STDERR_TAIL_BYTES);
        emit({ type: 'log', at: nowIso(), stream: 'stderr', text: line.slice(0, MAX_EVENT_TEXT) });
      },
      countBytes,
      drain.signal,
    );

    const done = (async (): Promise<SessionResult> => {
      await proc.exited;
      const drained = Promise.all([stdoutDone, stderrDone]);
      const late = setTimeout(() => drain.abort(), DRAIN_AFTER_EXIT_MS);
      await drained;
      clearTimeout(late);
      clearTimeout(timer);
      this.running.delete(input.sessionId);
      const exitCode = proc.exitCode;
      const summary = spec.decoder.summary();
      let outcome: SessionOutcome;
      if (cancelRequested) outcome = 'cancelled';
      else if (timedOut) outcome = 'timed_out';
      else if (limitExceeded || exitCode !== 0 || summary.failure) outcome = 'failed';
      else outcome = 'succeeded';
      if (outcome === 'failed' && !errorEmitted) {
        const lastLine = stderrTail.trim().split('\n').at(-1) ?? '';
        const message =
          summary.failure?.message ??
          (lastLine || `Process exited with ${exitCode === null ? `signal ${proc.signalCode}` : `code ${exitCode}`}`);
        emit({
          type: 'error',
          at: nowIso(),
          message,
          classification: summary.failure?.classification ?? classifyFailureText(stderrTail),
        });
      }
      const result = summary.result === null ? null : scrub(summary.result);
      if (summary.usage.usageSource !== 'unknown') emit({ type: 'usage', at: nowIso(), usage: summary.usage });
      emit({
        type: 'completed',
        at: nowIso(),
        outcome,
        exitCode,
        ...(result === null ? {} : { result }),
      });
      log.write('crew', `completed outcome=${outcome} exit=${exitCode ?? 'signal'}`);
      log.close();
      channel.close();
      return { outcome, exitCode, usage: summary.usage, result };
    })();

    this.running.set(input.sessionId, {
      pid,
      cancel: async () => {
        if (cancelRequested) return;
        cancelRequested = true;
        log.write('crew', 'cancellation requested');
        await graceKill(this.cancelGraceMs);
      },
    });

    return { sessionId: input.sessionId, pid, events: channel, done };
  }
}
