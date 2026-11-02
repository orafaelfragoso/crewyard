import type { RailContext } from '@agent-rail/storage';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useState } from 'react';
import type { ActionResult, ContextSearchResult, DashboardActions } from './actions.ts';
import { type DashboardData, useDashboardData, useEventBrowser } from './data.ts';
import { initialTheme, THEMES, type Theme } from './theme.ts';
import {
  ContextView,
  EventsView,
  filteredProjects,
  filteredQueue,
  filteredSessions,
  filteredTasks,
  MetricsView,
  OverviewView,
  ProjectsView,
  QueueView,
  SessionsView,
  StatusLine,
  TasksView,
  VIEWS,
  type ViewName,
} from './views.tsx';

type Mode =
  | { kind: 'normal' }
  | { kind: 'filter'; text: string }
  | { kind: 'search'; text: string }
  | { kind: 'reason'; label: string; text: string; run: (reason: string) => Promise<ActionResult> }
  | { kind: 'confirm'; label: string; run: () => Promise<ActionResult> }
  | { kind: 'help' }
  | { kind: 'inspect'; title: string; body: string };

export const HELP_LINES = [
  '1-8 / Tab / Shift+Tab  switch view',
  '↑↓ / j k / g G / PgUp PgDn  move selection',
  '/  filter rows (Context view: search the index)',
  'Enter  inspect task · open PR (Queue)',
  'p  pause/resume project intake    w  pause/resume workers',
  'r  retry with reason    e  escalate with reason',
  'a  approve permitted gate (confirm)    c  cancel managed session (confirm)',
  'o  open PR in browser    x  export diagnostics',
  '[ ]  older/newer events    L  resume live events',
  't  cycle theme (default, high-contrast, monochrome)',
  '?  help    q / Ctrl+C  quit',
];

interface DashboardProps {
  ctx: RailContext;
  actions: DashboardActions;
  projectId: string | null;
  initialView?: ViewName;
}

export function Dashboard(props: DashboardProps) {
  const [view, setView] = useState<ViewName>(props.initialView ?? 'Overview');
  const data = useDashboardData(props.ctx, props.projectId, view === 'Metrics');
  if (!data) return <Text>Loading Agent Rail state…</Text>;
  return <DashboardBody {...props} data={data} view={view} setView={setView} />;
}

function DashboardBody(props: DashboardProps & { data: DashboardData; view: ViewName; setView(view: ViewName): void }) {
  const { ctx, actions, projectId, data, view, setView } = props;
  const app = useApp();
  const size = useWindowSize();
  const [theme, setTheme] = useState<Theme>(initialTheme());
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [message, setMessage] = useState<string | null>(null);
  const [context, setContext] = useState<{ query: string; result: ContextSearchResult | null; busy: boolean }>({
    query: '',
    result: null,
    busy: false,
  });
  const bodyHeight = Math.max(5, (size.rows ?? 24) - 5);
  const events = useEventBrowser(ctx, projectId, bodyHeight - 2, data.cursor);

  const effectiveProject = projectId ?? data.projects[0]?.id ?? null;
  const rowsFor = (v: ViewName): number => {
    switch (v) {
      case 'Projects':
        return filteredProjects(data, filter).length;
      case 'Tasks':
        return filteredTasks(data, filter).length;
      case 'Sessions':
        return filteredSessions(data, filter).length;
      case 'Queue':
        return filteredQueue(data, filter).length;
      case 'Context':
        return context.result?.hits.length ?? 0;
      case 'Events':
        return events.state.items.length;
      default:
        return 0;
    }
  };
  const count = rowsFor(view);
  const clamp = (n: number) => Math.max(0, Math.min(Math.max(0, count - 1), n));
  const switchView = (v: ViewName) => {
    setView(v);
    setSelected(0);
    setFilter('');
  };
  const report = (p: Promise<ActionResult>) =>
    p
      .then((r) => setMessage(r.ok ? r.message : `failed: ${r.message}`))
      .catch((e: unknown) => setMessage(`failed: ${(e as Error).message}`));

  const selectedTask = () => filteredTasks(data, filter)[selected];
  const selectedQueue = () => filteredQueue(data, filter)[selected];
  const selectedSession = () => filteredSessions(data, filter)[selected];
  const selectedProject = () =>
    (view === 'Projects' ? filteredProjects(data, filter)[selected]?.id : effectiveProject) ?? null;

  useInput((input, key) => {
    if (mode.kind === 'filter' || mode.kind === 'search' || mode.kind === 'reason') {
      if (key.escape) return setMode({ kind: 'normal' });
      if (key.return) {
        if (mode.kind === 'filter') {
          setFilter(mode.text);
          setSelected(0);
        } else if (mode.kind === 'search') {
          if (effectiveProject && mode.text.trim()) {
            setContext({ query: mode.text, result: context.result, busy: true });
            actions
              .searchContext(effectiveProject, mode.text)
              .then((result) => setContext({ query: mode.text, result, busy: false }))
              .catch((e: unknown) => {
                setContext({ query: mode.text, result: null, busy: false });
                setMessage(`search failed: ${(e as Error).message}`);
              });
          }
        } else if (mode.text.trim().length > 0) {
          report(mode.run(mode.text.trim()));
        } else {
          setMessage('a reason is required');
        }
        return setMode({ kind: 'normal' });
      }
      if (key.backspace || key.delete) return setMode({ ...mode, text: mode.text.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) return setMode({ ...mode, text: mode.text + input });
      return;
    }
    if (mode.kind === 'confirm') {
      if (input === 'y' || input === 'Y') report(mode.run());
      else setMessage('cancelled');
      return setMode({ kind: 'normal' });
    }
    if (mode.kind === 'help' || mode.kind === 'inspect') return setMode({ kind: 'normal' });

    if (input === 'q' || (key.ctrl && input === 'c')) return app.exit();
    const digit = Number.parseInt(input, 10);
    if (digit >= 1 && digit <= VIEWS.length) return switchView(VIEWS[digit - 1]!);
    if (key.tab) {
      const i = VIEWS.indexOf(view);
      return switchView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length]!);
    }
    if (key.upArrow || input === 'k') return setSelected((s) => clamp(s - 1));
    if (key.downArrow || input === 'j') return setSelected((s) => clamp(s + 1));
    if (key.pageUp) return setSelected((s) => clamp(s - bodyHeight));
    if (key.pageDown) return setSelected((s) => clamp(s + bodyHeight));
    if (input === 'g') return setSelected(0);
    if (input === 'G') return setSelected(clamp(count - 1));
    if (input === '?') return setMode({ kind: 'help' });
    if (input === 't') return setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]!);
    if (input === '/')
      return setMode(view === 'Context' ? { kind: 'search', text: context.query } : { kind: 'filter', text: filter });
    if (input === '[') return events.older();
    if (input === ']') return events.newer();
    if (input === 'L') return events.live();
    if (input === 'x') return report(actions.exportDiagnostics());

    if (input === 'p' || input === 'w') {
      const pid = selectedProject();
      const project = data.projects.find((p) => p.id === pid);
      const overview = data.overview.projects.find((p) => p.id === pid);
      if (!pid || !project || !overview) return setMessage('no project selected');
      return input === 'p'
        ? report(actions.pauseProject(pid, !project.intakePaused))
        : report(actions.pauseWorkers(pid, !overview.workersPaused));
    }
    if (view === 'Tasks') {
      const task = selectedTask();
      if (!task) return;
      if (key.return) {
        actions
          .inspectTask(task.id)
          .then((detail) => setMode({ kind: 'inspect', title: task.id, body: JSON.stringify(detail, null, 2) }))
          .catch((e: unknown) => setMessage((e as Error).message));
        return;
      }
      if (input === 'r')
        return setMode({
          kind: 'reason',
          label: `Retry ${task.id} — reason`,
          text: '',
          run: (r) => actions.retryTask(task.id, r),
        });
      if (input === 'e')
        return setMode({
          kind: 'reason',
          label: `Escalate ${task.id} — reason`,
          text: '',
          run: (r) => actions.escalateTask(task.id, r),
        });
      if (input === 'a')
        return setMode({
          kind: 'confirm',
          label: `Approve gate for ${task.id}?`,
          run: () => actions.approveTask(task.id),
        });
    }
    if (view === 'Queue') {
      const entry = selectedQueue();
      if (!entry) return;
      if ((key.return || input === 'o') && entry.url) return report(actions.openUrl(entry.url));
      if (input === 'r') {
        return setMode({
          kind: 'reason',
          label: `Retry PR #${entry.prNumber} — reason`,
          text: '',
          run: (r) => actions.retryQueueEntry(entry.entryId, r),
        });
      }
      if (input === 'e') {
        return setMode({
          kind: 'reason',
          label: `Escalate PR #${entry.prNumber} — reason`,
          text: '',
          run: (r) => actions.escalateQueueEntry(entry.entryId, r),
        });
      }
    }
    if (view === 'Sessions' && input === 'c') {
      const session = selectedSession();
      if (!session) return;
      if (!session.managed) return setMessage('unmanaged sessions cannot be cancelled by Rail');
      return setMode({
        kind: 'confirm',
        label: `Cancel session ${session.id} (terminates its process tree)? [y/N]`,
        run: () => actions.cancelSession(session.id),
      });
    }
  });

  const props2 = { theme, data, selected, height: bodyHeight, width: size.columns ?? 80, filter };
  return (
    <Box flexDirection="column" height={size.rows}>
      <Box>
        <Text bold color={theme.accent}>
          Agent Rail{' '}
        </Text>
        {VIEWS.map((v, i) => (
          <Text key={v} {...(v === view ? { inverse: true, bold: true } : { color: theme.muted })}>
            {` ${i + 1} ${v} `}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {mode.kind === 'help' ? (
          <Box flexDirection="column">
            {HELP_LINES.map((l) => (
              <Text key={l}>{l}</Text>
            ))}
            <Text color={theme.muted}>press any key to close</Text>
          </Box>
        ) : mode.kind === 'inspect' ? (
          <Box flexDirection="column">
            <Text bold>{mode.title}</Text>
            <Text>
              {mode.body
                .split('\n')
                .slice(0, bodyHeight - 2)
                .join('\n')}
            </Text>
            <Text color={theme.muted}>press any key to close</Text>
          </Box>
        ) : view === 'Overview' ? (
          <OverviewView {...props2} />
        ) : view === 'Projects' ? (
          <ProjectsView {...props2} />
        ) : view === 'Tasks' ? (
          <TasksView {...props2} />
        ) : view === 'Sessions' ? (
          <SessionsView {...props2} />
        ) : view === 'Queue' ? (
          <QueueView {...props2} />
        ) : view === 'Context' ? (
          <ContextView
            theme={theme}
            result={context.result}
            query={context.query}
            selected={selected}
            height={bodyHeight}
            busy={context.busy}
          />
        ) : view === 'Events' ? (
          <EventsView
            theme={theme}
            events={events.state.items}
            selected={selected}
            height={bodyHeight}
            follow={events.state.follow}
            filter={filter}
          />
        ) : (
          <MetricsView {...props2} />
        )}
      </Box>
      {mode.kind === 'filter' || mode.kind === 'search' || mode.kind === 'reason' ? (
        <Text>
          {mode.kind === 'reason' ? mode.label : mode.kind === 'search' ? 'Search' : 'Filter'}: {mode.text}
          <Text inverse> </Text> <Text color={theme.muted}>(Enter apply · Esc cancel)</Text>
        </Text>
      ) : mode.kind === 'confirm' ? (
        <Text color={theme.warn}>{mode.label}</Text>
      ) : (
        <StatusLine theme={theme} data={data} message={message ?? (filter ? `filter: ${filter}` : '? help · q quit')} />
      )}
    </Box>
  );
}
