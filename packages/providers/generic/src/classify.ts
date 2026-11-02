import type { FailureClass } from '@agent-rail/core';

const RULES: readonly [RegExp, FailureClass][] = [
  [/rate[\s_-]?limit|\b429\b|too many requests|quota exceeded|usage limit|insufficient_quota/i, 'rate_limited'],
  [
    /\b401\b|\b403\b|unauthori[sz]ed|not logged in|authentication|invalid (?:api )?key|login required|forbidden|oauth|credential/i,
    'authentication',
  ],
  [
    /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error/i,
    'transient_network',
  ],
  [
    /overloaded|\b529\b|\b50[0234]\b|internal server error|service unavailable|bad gateway|server_error|stream disconnected/i,
    'transient_provider',
  ],
  [/permission denied|EACCES|EPERM|not permitted/i, 'missing_permissions'],
];

export function classifyFailureText(text: string): FailureClass {
  for (const [pattern, failureClass] of RULES) if (pattern.test(text)) return failureClass;
  return 'unknown';
}

export function classifyHttpStatus(status: number | null | undefined): FailureClass | null {
  if (status == null) return null;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 529 || status >= 500) return 'transient_provider';
  return null;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  second: 1,
  m: 60,
  min: 60,
  minute: 60,
  h: 3600,
  hour: 3600,
};

export function parseRetryAfterSeconds(text: string): number | null {
  const match =
    /(?:retry|try again)\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text) ??
    /retry-after:\s*(\d+)()/i.exec(text);
  if (!match) return null;
  const unit = (match[2] ?? '').toLowerCase().replace(/s$/, '') || 's';
  const factor = DURATION_UNITS[unit] ?? 1;
  return Math.ceil(Number(match[1]) * factor);
}
