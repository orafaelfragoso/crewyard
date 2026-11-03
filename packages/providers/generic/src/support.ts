import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  type AccountProfile,
  type AgentLaunch,
  CrewError,
  nowIso,
  type ProfileHealth,
  type ProfileHealthStatus,
  run,
  sanitizeEnv,
  which,
} from '@crewyard/core';

export type SecretResolver = (authRef: string) => Promise<string | null>;

export interface AdapterOptions {
  resolveSecret?: SecretResolver;
  cancelGraceMs?: number;
  baseEnv?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
}

export function settingString(profile: AccountProfile, key: string): string | null {
  const value = profile.settings[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function settingBool(profile: AccountProfile, key: string): boolean | null {
  const value = profile.settings[key];
  return typeof value === 'boolean' ? value : null;
}

export function settingStrings(profile: AccountProfile, key: string): string[] {
  const value = profile.settings[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function settingRecord(profile: AccountProfile, key: string): Record<string, string> {
  const value = profile.settings[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

export function resolveExecutable(command: string): string | null {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null;
  }
  return which(command);
}

export function unsupported(providerId: string, what: string, suggestion?: string): CrewError {
  return new CrewError('UNSUPPORTED_CAPABILITY', `${providerId} does not support ${what}`, {
    details: { providerId, capability: what },
    ...(suggestion ? { suggestion } : {}),
  });
}

export async function resolveApiKey(
  profile: AccountProfile,
  resolver: SecretResolver | undefined,
): Promise<string | null> {
  if (profile.authMechanism !== 'api-key') return null;
  if (!profile.authRef || !resolver) {
    throw new CrewError('UNAUTHENTICATED', `Profile ${profile.name} has no API key reference`, {
      suggestion: `Re-add the profile with an API key: crew account add ${profile.providerId} ${profile.name} --api-key`,
    });
  }
  const value = await resolver(profile.authRef);
  if (!value) {
    throw new CrewError('UNAUTHENTICATED', `API key for profile ${profile.name} is missing from the OS secret store`, {
      suggestion: `Re-add the profile credential: crew account add ${profile.providerId} ${profile.name} --api-key`,
    });
  }
  return value;
}

export function childEnv(
  options: AdapterOptions,
  passthrough: readonly string[],
  overrides: Record<string, string>,
): Record<string, string> {
  const base = sanitizeEnv(options.baseEnv ?? process.env);
  const source = options.baseEnv ?? process.env;
  for (const key of passthrough) {
    const value = source[key];
    if (value !== undefined) base[key] = value;
  }
  return { ...base, ...overrides };
}

export function promptWithInstructions(launch: AgentLaunch): string {
  if (!launch.systemInstructions) return launch.prompt;
  return `<system-instructions>\n${launch.systemInstructions}\n</system-instructions>\n\n${launch.prompt}`;
}

export interface VersionProbe {
  available: boolean;
  version: string | null;
  detail: string;
}

export async function probeVersion(
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 10_000,
): Promise<VersionProbe> {
  const executable = argv[0] ? resolveExecutable(argv[0]) : null;
  if (!executable) return { available: false, version: null, detail: `${argv[0]} not found on PATH` };
  try {
    const result = await run([executable, ...argv.slice(1)], { env, timeoutMs, allowFailure: true });
    if (result.exitCode !== 0) {
      return { available: false, version: null, detail: `${argv.join(' ')} exited ${result.exitCode}` };
    }
    const text = `${result.stdout}\n${result.stderr}`;
    const version = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)?.[1] ?? null;
    return { available: true, version, detail: text.trim().split('\n')[0] ?? '' };
  } catch (error) {
    return { available: false, version: null, detail: (error as Error).message };
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function health(status: ProfileHealthStatus, detail: string): ProfileHealth {
  return { status, detail, checkedAt: nowIso() };
}

export const CREW_MCP_SERVER_NAME = 'crewyard';

export function crewSkillsSource(launch: AgentLaunch): string | null {
  return launch.skillsDir ? join(launch.skillsDir, 'skills') : null;
}

export function syncCrewSkills(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) {
    throw new CrewError('UNAVAILABLE', `Crewyard Skills folder is missing: ${sourceDir}`, {
      suggestion: 'Start the session again; Crewyard recreates the folder.',
    });
  }
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(targetDir)) {
    if (entry.startsWith('crew-')) rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(sourceDir)) {
    if (entry.startsWith('crew-')) cpSync(join(sourceDir, entry), join(targetDir, entry), { recursive: true });
  }
}
