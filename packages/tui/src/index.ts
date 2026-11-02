import type { CrewContext } from '@crewyard/storage';
import { render, renderToString } from 'ink';
import { createElement } from 'react';
import type { DashboardActions } from './actions.ts';
import { Dashboard } from './app.tsx';
import { loadDashboard } from './data.ts';
import { initialTheme } from './theme.ts';
import { MetricsView, OverviewView, type ViewName } from './views.tsx';

export type { ActionResult, ContextHit, ContextSearchResult, DashboardActions } from './actions.ts';
export { HELP_LINES } from './app.tsx';
export { type DashboardData, loadDashboard } from './data.ts';
export { THEMES, type Theme } from './theme.ts';
export { VIEWS, type ViewName } from './views.tsx';

export interface DashboardOptions {
  projectId: string | null;
  initialView?: ViewName;
}

export async function runDashboard(
  ctx: CrewContext,
  actions: DashboardActions,
  options: DashboardOptions,
): Promise<void> {
  const instance = render(
    createElement(Dashboard, {
      ctx,
      actions,
      projectId: options.projectId,
      ...(options.initialView ? { initialView: options.initialView } : {}),
    }),
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
}

export function renderSnapshot(ctx: CrewContext, projectId: string | null, columns = 120): string {
  const data = loadDashboard(ctx, projectId, true);
  const theme = initialTheme({ ...process.env, NO_COLOR: '1' });
  const props = { theme, data, selected: 0, height: 40, width: columns, filter: '' };
  return [
    renderToString(createElement(OverviewView, props), { columns }),
    renderToString(createElement(MetricsView, props), { columns }),
  ].join('\n');
}
