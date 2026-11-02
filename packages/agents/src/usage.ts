import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import type { CostSource, UsageReport } from '@crewyard/core';
import { all, one } from '@crewyard/storage';

export type BudgetScope = 'global' | 'project' | 'agent' | 'profile' | 'task';

export function resolveCost(
  usage: UsageReport,
  providerId: string,
  model: string | null,
  rates: CrewConfig['observability']['rates'],
): { costUsd: number | null; costSource: CostSource } {
  if (usage.costSource === 'reported' && usage.costUsd !== null)
    return { costUsd: usage.costUsd, costSource: 'reported' };
  if (usage.usageSource === 'unknown' || usage.inputTokens === null || usage.outputTokens === null) {
    return { costUsd: null, costSource: 'unknown' };
  }
  const effectiveModel = usage.model ?? model;
  const rate = rates.find((r) => r.provider === providerId && r.model === effectiveModel);
  if (!rate) return { costUsd: null, costSource: 'unknown' };
  const cost =
    (usage.inputTokens * rate.input_per_mtok_usd + usage.outputTokens * rate.output_per_mtok_usd) / 1_000_000;
  return { costUsd: Math.round(cost * 1e6) / 1e6, costSource: 'configured_rate' };
}

export interface BudgetStatus {
  budgetId: string;
  scope: BudgetScope;
  scopeId: string;
  period: 'day' | 'month' | 'total';
  tokenLimit: number | null;
  costLimitUsd: number | null;
  usedTokens: number;
  usedCostUsd: number;
  unknownUsageSessions: number;
  exceeded: boolean;
}

interface BudgetRow {
  id: string;
  scope_kind: BudgetScope;
  scope_id: string;
  period: 'day' | 'month' | 'total';
  token_limit: number | null;
  cost_limit_usd: number | null;
}

function periodStart(period: BudgetRow['period'], now: Date): string {
  if (period === 'total') return '0000';
  const start =
    period === 'day'
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return start.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SCOPE_FILTER: Record<BudgetScope, string> = {
  global: '1 = 1',
  profile: 'u.profile_id = ?',
  agent: 's.agent_id = ?',
  task: 's.task_id = ?',
  project: 's.task_id IN (SELECT id FROM tasks WHERE project_id = ?)',
};

export function budgetStatuses(
  db: Database,
  subjects: Partial<Record<Exclude<BudgetScope, 'global'>, string | null>>,
  now: Date,
): BudgetStatus[] {
  const out: BudgetStatus[] = [];
  for (const scope of Object.keys(SCOPE_FILTER) as BudgetScope[]) {
    const scopeId = scope === 'global' ? null : subjects[scope];
    if (scope !== 'global' && !scopeId) continue;
    const budgets = scopeId
      ? all<BudgetRow>(db, 'SELECT * FROM budgets WHERE scope_kind = ? AND scope_id = ?', scope, scopeId)
      : all<BudgetRow>(db, `SELECT * FROM budgets WHERE scope_kind = 'global'`);
    for (const budget of budgets) {
      const params = scopeId ? [scopeId] : [];
      const used = one<{ tokens: number | null; cost: number | null; unknown: number | null }>(
        db,
        `SELECT SUM(COALESCE(u.input_tokens, 0) + COALESCE(u.output_tokens, 0)) AS tokens, SUM(u.cost_usd) AS cost,
                SUM(CASE WHEN u.usage_source = 'unknown' THEN 1 ELSE 0 END) AS unknown
         FROM session_usage u JOIN sessions s ON s.id = u.session_id
         WHERE u.at >= ? AND ${SCOPE_FILTER[scope]}`,
        periodStart(budget.period, now),
        ...params,
      );
      const usedTokens = used?.tokens ?? 0;
      const usedCostUsd = used?.cost ?? 0;
      out.push({
        budgetId: budget.id,
        scope,
        scopeId: budget.scope_id,
        period: budget.period,
        tokenLimit: budget.token_limit,
        costLimitUsd: budget.cost_limit_usd,
        usedTokens,
        usedCostUsd,
        unknownUsageSessions: used?.unknown ?? 0,
        exceeded:
          (budget.token_limit !== null && usedTokens >= budget.token_limit) ||
          (budget.cost_limit_usd !== null && usedCostUsd >= budget.cost_limit_usd),
      });
    }
  }
  return out;
}
