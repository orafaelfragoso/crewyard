import type { CrewConfig } from '@crewyard/config';
import type { ReservationMode, ReservationSource, Task } from './model.ts';

export interface ScopeRequest {
  scope: string;
  mode: ReservationMode;
  source: ReservationSource;
}

const GLOB_CHARS = /[*?[\]{}]/;

export function isResourceScope(scope: string): boolean {
  return /^[a-z][a-z0-9_-]*:/i.test(scope.trim());
}

export function normalizeScope(scope: string): string {
  const trimmed = scope.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (isResourceScope(trimmed)) return trimmed;
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (GLOB_CHARS.test(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

export function scopesOverlap(a: string, b: string): boolean {
  const resourceA = isResourceScope(a.trim());
  const resourceB = isResourceScope(b.trim());
  if (resourceA || resourceB) return resourceA && resourceB && a.trim() === b.trim();
  const left = normalizeScope(a);
  const right = normalizeScope(b);
  if (left === '' || right === '') return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function requestedScopes(
  task: Pick<Task, 'scopeHints' | 'exclusiveResources' | 'risk'>,
  config: CrewConfig,
  impactScopes: readonly string[] = [],
): ScopeRequest[] {
  const out = new Map<string, ScopeRequest>();
  const put = (scope: string, mode: ReservationMode, source: ReservationSource) => {
    const key = scope.trim();
    if (key === '') return;
    const existing = out.get(key);
    if (existing?.mode === 'exclusive') return;
    out.set(key, { scope: key, mode, source });
  };
  for (const scope of task.exclusiveResources) put(scope, 'exclusive', 'explicit');
  const protect = config.scheduler.protect_high_risk_scopes && task.risk === 'high';
  for (const scope of task.scopeHints) put(scope, protect ? 'exclusive' : 'advisory', protect ? 'config' : 'explicit');
  for (const scope of impactScopes) put(scope, 'advisory', 'impact');
  return [...out.values()].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

export interface ScopeHolding {
  taskId: string;
  scope: string;
  mode: ReservationMode;
}

export interface ScopeConflict {
  scope: string;
  mode: ReservationMode;
  conflictingTaskId: string;
  conflictingScope: string;
  conflictingMode: ReservationMode;
}

export function findScopeConflicts(
  requests: readonly ScopeRequest[],
  held: readonly ScopeHolding[],
  taskId: string,
): { exclusive: ScopeConflict[]; advisory: ScopeConflict[] } {
  const exclusive: ScopeConflict[] = [];
  const advisory: ScopeConflict[] = [];
  for (const request of requests) {
    for (const holding of held) {
      if (holding.taskId === taskId || !scopesOverlap(request.scope, holding.scope)) continue;
      const conflict: ScopeConflict = {
        scope: request.scope,
        mode: request.mode,
        conflictingTaskId: holding.taskId,
        conflictingScope: holding.scope,
        conflictingMode: holding.mode,
      };
      if (request.mode === 'exclusive' || holding.mode === 'exclusive') exclusive.push(conflict);
      else advisory.push(conflict);
    }
  }
  return { exclusive, advisory };
}
