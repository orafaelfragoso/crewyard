import { type CrewContext, type CrewEvent, latestSeq } from '@crewyard/storage';
import {
  computeMetrics,
  type MetricsReport,
  type OverviewProjection,
  overviewProjection,
  type ProjectRow,
  pageEvents,
  projectRows,
  type QueueRow,
  queueRows,
  type SessionRow,
  sessionRows,
  type TaskBoardRow,
  taskBoard,
} from '@crewyard/telemetry';
import { useEffect, useRef, useState } from 'react';

export interface DashboardData {
  overview: OverviewProjection;
  projects: ProjectRow[];
  tasks: TaskBoardRow[];
  sessions: SessionRow[];
  queue: QueueRow[];
  metrics: MetricsReport | null;
  cursor: number;
  loadedAt: string;
  stale: boolean;
  error: string | null;
}

export function loadDashboard(ctx: CrewContext, projectId: string | null, includeMetrics: boolean): DashboardData {
  return {
    overview: overviewProjection(ctx, projectId),
    projects: projectRows(ctx),
    tasks: taskBoard(ctx, { projectId, limit: 500 }),
    sessions: sessionRows(ctx, { limit: 200 }),
    queue: queueRows(ctx, projectId),
    metrics: includeMetrics ? computeMetrics(ctx, { projectId }) : null,
    cursor: latestSeq(ctx.store.db),
    loadedAt: new Date().toISOString(),
    stale: false,
    error: null,
  };
}

export function useDashboardData(
  ctx: CrewContext,
  projectId: string | null,
  includeMetrics: boolean,
  pollMs = 1000,
): DashboardData | null {
  const [data, setData] = useState<DashboardData | null>(null);
  const cursor = useRef(-1);
  const metricsWanted = useRef(includeMetrics);
  metricsWanted.current = includeMetrics;

  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      try {
        const seq = latestSeq(ctx.store.db);
        if (seq !== cursor.current || (metricsWanted.current && data?.metrics == null)) {
          cursor.current = seq;
          setData(loadDashboard(ctx, projectId, metricsWanted.current));
        } else {
          setData((prev) => (prev && (prev.stale || prev.error) ? { ...prev, stale: false, error: null } : prev));
        }
      } catch (error) {
        cursor.current = -1;
        setData((prev) => (prev ? { ...prev, stale: true, error: (error as Error).message } : prev));
      }
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ctx, projectId, pollMs, data?.metrics]);

  return data;
}

export interface EventBrowserState {
  items: CrewEvent[];
  before: number | null;
  after: number | null;
  follow: boolean;
}

export function useEventBrowser(ctx: CrewContext, projectId: string | null, pageSize: number, liveCursor: number) {
  const [state, setState] = useState<EventBrowserState>({ items: [], before: null, after: null, follow: true });

  // biome-ignore lint/correctness/useExhaustiveDependencies: liveCursor triggers a reload of the newest page when events arrive
  useEffect(() => {
    if (!state.follow) return;
    const page = pageEvents(ctx, { ...(projectId ? { projectId } : {}), limit: pageSize, direction: 'older' });
    setState({ items: page.items, before: page.cursor.before, after: page.cursor.after, follow: true });
  }, [ctx, projectId, pageSize, liveCursor, state.follow]);

  const older = () => {
    if (state.before === null) return;
    const page = pageEvents(ctx, {
      ...(projectId ? { projectId } : {}),
      limit: pageSize,
      direction: 'older',
      beforeSeq: state.before,
    });
    if (page.items.length > 0)
      setState({ items: page.items, before: page.cursor.before, after: page.cursor.after, follow: false });
  };
  const newer = () => {
    if (state.after === null) return;
    const page = pageEvents(ctx, {
      ...(projectId ? { projectId } : {}),
      limit: pageSize,
      direction: 'newer',
      afterSeq: state.after,
    });
    if (page.items.length === 0) setState((s) => ({ ...s, follow: true }));
    else setState({ items: page.items, before: page.cursor.before, after: page.cursor.after, follow: false });
  };
  const live = () => setState((s) => ({ ...s, follow: true }));
  return { state, older, newer, live };
}
