import { listSessionEvents, type SessionEventRecord, type StartedSession, stopSession } from '@crewyard/agents';
import type { CrewContext } from '@crewyard/storage';
import { type GlobalOptions, progress } from './output.ts';
import { operatorActor } from './program.ts';

const POLL_MS = 1_000;
const QUIET_NOTICE_MS = 30_000;

function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function firstLine(text: unknown, max = 100): string {
  const line =
    String(text ?? '')
      .split('\n')
      .find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

export function describeSessionEvent(event: SessionEventRecord): string | null {
  const p = event.payload;
  switch (event.type) {
    case 'agent.tool':
      return p.status === 'started'
        ? `→ ${String(p.name)}`
        : p.status === 'failed'
          ? `✗ ${String(p.name)} failed`
          : null;
    case 'agent.message':
      return p.role === 'assistant' && firstLine(p.text) ? `· ${firstLine(p.text)}` : null;
    case 'agent.error':
      return `✗ ${firstLine(p.message)}`;
    case 'session.stopping':
      return `stopping: ${String(p.reason ?? '')}`;
    default:
      return null;
  }
}

export interface SessionWatch {
  stop(): void;
}

export function watchSession(
  ctx: CrewContext,
  opts: GlobalOptions,
  session: StartedSession,
  intro: string,
): SessionWatch {
  progress(opts, intro);
  progress(
    opts,
    `  agent session ${session.sessionId} · ${session.profileRef}${session.model ? ` · ${session.model}` : ''}`,
  );
  progress(opts, `  full log: crew agent logs ${session.sessionId}   (Ctrl-C stops the session)`);
  const started = Date.now();
  let lastSeq = 0;
  let lastOutput = Date.now();
  const timer = setInterval(() => {
    for (const event of listSessionEvents(ctx, session.sessionId, { afterSeq: lastSeq, limit: 500 })) {
      lastSeq = event.seq;
      const line = describeSessionEvent(event);
      if (line) {
        progress(opts, `  [${elapsed(Date.now() - started)}] ${line}`);
        lastOutput = Date.now();
      }
    }
    if (Date.now() - lastOutput >= QUIET_NOTICE_MS) {
      progress(opts, `  [${elapsed(Date.now() - started)}] still working…`);
      lastOutput = Date.now();
    }
  }, POLL_MS);
  const interrupt = () => {
    progress(opts, '  stopping the agent session…');
    void stopSession(ctx, session.sessionId, { actor: operatorActor(), reason: 'operator interrupt' });
  };
  process.once('SIGINT', interrupt);
  return {
    stop() {
      clearInterval(timer);
      process.off('SIGINT', interrupt);
    },
  };
}
