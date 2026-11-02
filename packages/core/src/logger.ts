import { redact } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(
  options: { level?: LogLevel; base?: Record<string, unknown>; write?: (line: string) => void } = {},
): Logger {
  const level = options.level ?? ((process.env.CREW_LOG_LEVEL as LogLevel | undefined) || 'warn');
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(redact(JSON.stringify({ level: lvl, at: new Date().toISOString(), message, ...base, ...fields })));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ level, base: { ...base, ...fields }, write }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
