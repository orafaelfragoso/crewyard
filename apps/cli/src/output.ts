import { createInterface } from 'node:readline/promises';
import { CrewError, redactObject, toCrewError } from '@crewyard/core';

export interface GlobalOptions {
  json?: boolean;
  project?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(redactObject(value))}\n`);
}

export function writeLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function progress(opts: GlobalOptions, text: string): void {
  if (!opts.json) process.stderr.write(`${text}\n`);
}

export function emit<T>(opts: GlobalOptions, data: T, human: (data: T) => string | string[]): void {
  if (opts.json) {
    writeJson({ ok: true, data });
    return;
  }
  const out = human(data);
  writeLine(Array.isArray(out) ? out.join('\n') : out);
}

export function emitChange<T extends object>(
  opts: GlobalOptions,
  data: T,
  human: (data: T) => string | string[],
): void {
  if (opts.dryRun) emit(opts, { ...data, dryRun: true }, (d) => ['dry run, nothing changed:', ...[human(d)].flat()]);
  else emit(opts, data, human);
}

export function table(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '(none)';
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown) =>
    v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const widths = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (values: string[]) =>
    values.map((v, i) => (v.length > widths[i]! ? `${v.slice(0, widths[i]! - 1)}…` : v.padEnd(widths[i]!))).join('  ');
  return [line(cols.map((c) => c.toUpperCase())), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

export function keyValues(record: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(record).map((k) => k.length));
  return Object.entries(record)
    .map(
      ([k, v]) =>
        `${k.padEnd(width)}  ${v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
    )
    .join('\n');
}

export async function confirm(opts: GlobalOptions, message: string): Promise<void> {
  if (opts.yes) return;
  if (opts.json || !process.stdin.isTTY) {
    throw new CrewError('APPROVAL_REQUIRED', `${message} — confirmation required`, {
      suggestion: 'Re-run with --yes to confirm, or use --dry-run to preview.',
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes')
      throw new CrewError('APPROVAL_REQUIRED', 'Cancelled by operator', { retryable: false });
  } finally {
    rl.close();
  }
}

export function reportError(error: unknown, json: boolean): number {
  const crew = toCrewError(error);
  if (json) {
    writeJson({ ok: false, error: crew.toJSON() });
  } else {
    process.stderr.write(`error ${crew.code}: ${crew.message}\n`);
    if (crew.suggestion) process.stderr.write(`hint: ${crew.suggestion}\n`);
    const issues = crew.details?.issues;
    if (Array.isArray(issues)) {
      for (const issue of issues as { path: string; message: string }[])
        process.stderr.write(`  - ${issue.path}: ${issue.message}\n`);
    }
    if (crew.code === 'INTERNAL' && process.env.CREW_DEBUG && crew.cause instanceof Error) {
      process.stderr.write(`${crew.cause.stack ?? ''}\n`);
    }
  }
  return crew.exitCode;
}
