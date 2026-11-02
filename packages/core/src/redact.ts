const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\brail_[A-Za-z0-9_-]{40,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

const ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`]{8,})\3/gi;

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redactions++;
      return REDACTED;
    });
  }
  out = out.replace(ASSIGNMENT_PATTERN, (_m, key: string, sep: string, quote: string) => {
    redactions++;
    return `${key}${sep}${quote}${REDACTED}${quote}`;
  });
  return { text: out, redactions };
}

export function redact(text: string): string {
  return redactSecrets(text).text;
}

const SECRET_KEY_NAMES = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key|cookie)/i;

export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.test(key);
}

export function redactObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactObject(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKeyName(k) && !k.endsWith('Ref') && !k.endsWith('_ref') && typeof v === 'string') out[k] = REDACTED;
      else out[k] = redactObject(v);
    }
    return out as T;
  }
  if (typeof value === 'string') return redact(value) as T;
  return value;
}
