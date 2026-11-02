export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function toIso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nowIso(clock: Clock = systemClock): string {
  return toIso(clock.now());
}

export function addSeconds(iso: string, seconds: number): string {
  return toIso(new Date(Date.parse(iso) + seconds * 1000));
}

export function isExpired(iso: string | null | undefined, clock: Clock = systemClock): boolean {
  return iso != null && Date.parse(iso) <= clock.now().getTime();
}

export function backoffWithJitter(attempt: number, baseMs = 250, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
