export type JsonObject = Record<string, unknown>;

export function parseJsonLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function obj(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

export function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function truncate(text: string, max = 500): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
