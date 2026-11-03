import { CREW_POLICY_CLASS, CREW_POLICY_PATHS, type CrewConfig } from '@crewyard/config';
import type { Risk } from '@crewyard/core';

const globCache = new Map<string, Bun.Glob>();

export function matchesGlob(pattern: string, path: string): boolean {
  let glob = globCache.get(pattern);
  if (!glob) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(path);
}

export function matchesAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}

export type SecurityPolicy = Pick<CrewConfig['security'], 'sensitive_paths' | 'require_approval_for'>;

export interface PathClassification {
  classes: string[];
  matches: Record<string, string[]>;
  approvalClasses: string[];
  risk: Risk;
}

export interface ChangeSize {
  files: number;
  additions?: number;
  deletions?: number;
}

const MEDIUM_FILES = 20;
const MEDIUM_LINES = 400;

export function classifyPaths(policy: SecurityPolicy, paths: readonly string[], size?: ChangeSize): PathClassification {
  const matches: Record<string, string[]> = {};
  for (const [cls, patterns] of [
    ...Object.entries(policy.sensitive_paths),
    [CREW_POLICY_CLASS, CREW_POLICY_PATHS] as const,
  ]) {
    const hit = paths.filter((path) => matchesAny(patterns, path)).sort();
    if (hit.length > 0) matches[cls] = hit;
  }
  const classes = Object.keys(matches).sort();
  const approvalClasses = classes.filter(
    (cls) => cls === CREW_POLICY_CLASS || (policy.require_approval_for as readonly string[]).includes(cls),
  );
  const lines = (size?.additions ?? 0) + (size?.deletions ?? 0);
  const risk: Risk =
    classes.length > 0
      ? 'high'
      : (size?.files ?? paths.length) > MEDIUM_FILES || lines > MEDIUM_LINES
        ? 'medium'
        : 'low';
  if (risk === 'high' && policy.require_approval_for.includes('high-risk') && !approvalClasses.includes('high-risk')) {
    approvalClasses.push('high-risk');
  }
  return { classes, matches, approvalClasses, risk };
}
