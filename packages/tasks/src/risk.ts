import { CREW_POLICY_CLASS, CREW_POLICY_PATHS, type CrewConfig } from '@crewyard/config';
import type { Risk } from '@crewyard/core';
import type { ApprovalClass } from './model.ts';
import { isResourceScope } from './scopes.ts';

export interface RiskClassificationInput {
  risk: Risk;
  scopeHints?: readonly string[];
  exclusiveResources?: readonly string[];
  changedPaths?: readonly string[];
}

export interface RiskMatch {
  class: ApprovalClass;
  path: string;
  pattern: string;
}

export interface RiskClassification {
  detectedClasses: ApprovalClass[];
  requiredClasses: ApprovalClass[];
  matches: RiskMatch[];
}

const APPROVAL_CLASS_ORDER: readonly ApprovalClass[] = [
  'crew-policy',
  'security-sensitive',
  'database-migration',
  'deployment-config',
  'dependency-change',
  'high-risk',
];

const RESOURCE_CLASSES: readonly { pattern: RegExp; class: ApprovalClass }[] = [
  { pattern: /^(schema|migration|migrations|db|database):/i, class: 'database-migration' },
  { pattern: /^(auth|security|secrets|permissions|payments|billing):/i, class: 'security-sensitive' },
  { pattern: /^(deploy|deployment|infra|ci):/i, class: 'deployment-config' },
];

const PROBE = '__crew_probe__';

function probePath(scope: string): string {
  return scope
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\*\*/g, PROBE)
    .replace(/\*/g, PROBE)
    .replace(/\?/g, 'x');
}

function isApprovalClass(name: string): name is ApprovalClass {
  return (APPROVAL_CLASS_ORDER as readonly string[]).includes(name);
}

export function classifyRisk(input: RiskClassificationInput, config: CrewConfig): RiskClassification {
  const matches: RiskMatch[] = [];
  const seen = new Set<string>();
  const add = (match: RiskMatch) => {
    const key = `${match.class}\0${match.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(match);
  };
  const paths = [...(input.scopeHints ?? []), ...(input.changedPaths ?? [])].filter((p) => !isResourceScope(p));
  const globs = [
    ...Object.entries(config.security.sensitive_paths),
    [CREW_POLICY_CLASS, CREW_POLICY_PATHS] as const,
  ].flatMap(([name, patterns]) =>
    isApprovalClass(name) ? patterns.map((pattern) => ({ class: name, pattern, glob: new Bun.Glob(pattern) })) : [],
  );
  for (const path of paths) {
    const probe = probePath(path);
    for (const entry of globs) {
      if (entry.glob.match(probe) || entry.glob.match(`${probe.replace(/\/$/, '')}/${PROBE}`)) {
        add({ class: entry.class, path, pattern: entry.pattern });
      }
    }
  }
  const resources = [...(input.exclusiveResources ?? []), ...(input.scopeHints ?? [])].filter(isResourceScope);
  for (const resource of resources) {
    for (const rule of RESOURCE_CLASSES) {
      if (rule.pattern.test(resource)) add({ class: rule.class, path: resource, pattern: rule.pattern.source });
    }
  }
  if (input.risk === 'high') add({ class: 'high-risk', path: '*', pattern: 'risk=high' });
  const detected = new Set(matches.map((m) => m.class));
  const detectedClasses = APPROVAL_CLASS_ORDER.filter((c) => detected.has(c));
  const required = new Set<ApprovalClass>(config.security.require_approval_for);
  required.add('high-risk');
  required.add(CREW_POLICY_CLASS);
  return {
    detectedClasses,
    requiredClasses: detectedClasses.filter((c) => required.has(c)),
    matches,
  };
}
