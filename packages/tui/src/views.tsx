import type { CrewEvent } from '@crewyard/storage';
import type { Measured, ProjectRow, QueueRow, SessionRow, TaskBoardRow } from '@crewyard/telemetry';
import { Box, Text } from 'ink';
import type { ContextHit, ContextSearchResult } from './actions.ts';
import { type Column, KeyValue, localTime, Panel, StateText, shortSha, Table } from './components.tsx';
import type { DashboardData } from './data.ts';
import { stateColor, type Theme } from './theme.ts';

export const VIEWS = ['Overview', 'Projects', 'Tasks', 'Sessions', 'Queue', 'Context', 'Events', 'Metrics'] as const;
export type ViewName = (typeof VIEWS)[number];

interface ViewProps {
  theme: Theme;
  data: DashboardData;
  selected: number;
  height: number;
  width: number;
  filter: string;
}

const matches = (filter: string, ...values: (string | number | null | undefined)[]) =>
  filter === '' || values.some((v) => v != null && String(v).toLowerCase().includes(filter.toLowerCase()));

export function filteredProjects(data: DashboardData, filter: string): ProjectRow[] {
  return data.projects.filter((p) => matches(filter, p.name, p.repository, p.autonomy, p.indexStatus));
}
export function filteredTasks(data: DashboardData, filter: string): TaskBoardRow[] {
  return data.tasks.filter((t) => matches(filter, t.id, t.title, t.state, t.owner, t.risk, t.blocker));
}
export function filteredSessions(data: DashboardData, filter: string): SessionRow[] {
  return data.sessions.filter((s) =>
    matches(filter, s.id, s.agent, s.providerId, s.profile, s.model, s.taskId, s.state),
  );
}
export function filteredQueue(data: DashboardData, filter: string): QueueRow[] {
  return data.queue.filter((q) => matches(filter, q.prNumber, q.prTitle, q.status, q.baseBranch, q.mode));
}

export function OverviewView({ theme, data }: ViewProps) {
  const o = data.overview;
  const states = [
    'READY',
    'CLAIMED',
    'RUNNING',
    'SUBMITTED',
    'REVIEWING',
    'REVISION',
    'QUEUED',
    'VALIDATING',
    'BLOCKED',
    'ESCALATED',
  ] as const;
  return (
    <Box flexDirection="column">
      <Box>
        <Panel theme={theme} title="Work">
          {states.map((s) => (
            <KeyValue key={s} theme={theme} label={s} value={o.tasksByState[s] ?? 0} color={stateColor(theme, s)} />
          ))}
        </Panel>
        <Panel theme={theme} title="Throughput">
          <KeyValue theme={theme} label="Running agents" value={o.runningSessions} />
          <KeyValue theme={theme} label="Open PRs" value={o.openPrs} />
          <KeyValue theme={theme} label="Queued" value={o.queued} />
          <KeyValue theme={theme} label="Merged (24h)" value={o.mergedLast24h} color={theme.ok} />
          <KeyValue
            theme={theme}
            label="Pending approvals"
            value={o.pendingApprovals}
            color={o.pendingApprovals ? theme.warn : undefined}
          />
          <KeyValue
            theme={theme}
            label="Service"
            value={
              o.service.running
                ? `running (${localTime(o.service.lastHeartbeatAt)})`
                : 'stopped — autonomous work is not running'
            }
            color={o.service.running ? theme.ok : theme.warn}
          />
          {o.projects.map((p) => (
            <KeyValue
              key={p.id}
              theme={theme}
              label={p.name}
              value={`${p.autonomy}${p.intakePaused ? ' · intake paused' : ''}${p.workersPaused ? ' · workers paused' : ''}`}
            />
          ))}
        </Panel>
      </Box>
      <Panel theme={theme} title="Alerts">
        {o.alerts.length === 0 ? <Text color={theme.muted}>No unread alerts</Text> : null}
        {o.alerts.slice(0, 8).map((a) => (
          <Text
            key={`${a.at}${a.title}`}
            color={a.level === 'error' ? theme.error : a.level === 'info' ? undefined : theme.warn}
          >
            [{a.level}] {a.title} {a.body ? `— ${a.body}` : ''}
          </Text>
        ))}
      </Panel>
    </Box>
  );
}

export function ProjectsView({ theme, data, selected, height, filter }: ViewProps) {
  const columns: Column<ProjectRow>[] = [
    { header: 'Project', width: 18, value: (r) => r.name },
    { header: 'Autonomy', width: 10, value: (r) => r.autonomy },
    {
      header: 'Intake',
      width: 8,
      value: (r) => (r.intakePaused ? 'paused' : 'open'),
      color: (r) => (r.intakePaused ? theme.warn : theme.ok),
    },
    { header: 'Base', width: 10, value: (r) => r.defaultBase },
    { header: 'Indexed', width: 10, value: (r) => shortSha(r.indexedCommit) },
    {
      header: 'Index',
      width: 10,
      value: (r) => r.indexStatus,
      color: (r) => stateColor(theme, r.indexStatus === 'available' ? 'passed' : 'pending'),
    },
    { header: 'Backlog', width: 8, value: (r) => String(r.backlog) },
    { header: 'Policy', width: 7, value: (r) => `r${r.policyRevision}` },
    { header: 'Repository', width: 40, value: (r) => r.repository },
  ];
  return (
    <Table
      theme={theme}
      columns={columns}
      rows={filteredProjects(data, filter)}
      selected={selected}
      height={height}
      empty="No projects. Run `crew init`."
    />
  );
}

export function TasksView({ theme, data, selected, height, filter }: ViewProps) {
  const columns: Column<TaskBoardRow>[] = [
    { header: 'Task', width: 10, value: (r) => r.id },
    {
      header: 'State',
      width: 16,
      value: (r) => (r.paused ? `${r.state} (paused)` : r.state),
      color: (r) => stateColor(theme, r.state),
    },
    { header: 'Pri', width: 4, value: (r) => String(r.priority) },
    { header: 'Risk', width: 6, value: (r) => r.risk, color: (r) => (r.risk === 'high' ? theme.error : undefined) },
    { header: 'Owner', width: 14, value: (r) => r.owner ?? '—' },
    { header: 'Deps', width: 14, value: (r) => r.dependencies.join(',') || '—' },
    { header: 'Age h', width: 6, value: (r) => String(r.ageHours) },
    { header: 'Try', width: 4, value: (r) => String(r.attempts) },
    { header: 'Title / blocker', width: 50, value: (r) => (r.blocker ? `${r.title} ⟂ ${r.blocker}` : r.title) },
  ];
  return (
    <Table
      theme={theme}
      columns={columns}
      rows={filteredTasks(data, filter)}
      selected={selected}
      height={height}
      empty="No tasks."
    />
  );
}

export function SessionsView({ theme, data, selected, height, filter }: ViewProps) {
  const rows = filteredSessions(data, filter);
  const columns: Column<SessionRow>[] = [
    { header: 'Session', width: 14, value: (r) => r.id.slice(0, 14) },
    { header: 'Agent', width: 12, value: (r) => r.agent ?? (r.managed ? '—' : 'unmanaged') },
    { header: 'Provider', width: 9, value: (r) => r.providerId },
    { header: 'Profile', width: 10, value: (r) => r.profile ?? '—' },
    { header: 'Model', width: 14, value: (r) => r.model ?? 'default' },
    { header: 'Task', width: 9, value: (r) => r.taskId ?? '—' },
    { header: 'State', width: 10, value: (r) => r.state, color: (r) => stateColor(theme, r.state) },
    {
      header: 'Tokens in/out',
      width: 15,
      value: (r) => (r.usageStatus === 'unknown' ? 'unknown' : `${r.inputTokens ?? 0}/${r.outputTokens ?? 0}`),
    },
    { header: 'Last activity', width: 40, value: (r) => r.lastOutput ?? '' },
  ];
  const current = rows[selected];
  return (
    <Box flexDirection="column">
      <Table
        theme={theme}
        columns={columns}
        rows={rows}
        selected={selected}
        height={Math.max(3, height - 4)}
        empty="No sessions."
      />
      {current && !current.managed ? (
        <Text color={theme.warn}>
          Unmanaged session: Crewyard cannot cancel it, enforce its workspace, or account its usage.
        </Text>
      ) : null}
      {current ? (
        <Text color={theme.muted}>
          pid {current.pid ?? '—'} · started {localTime(current.startedAt)} · heartbeat{' '}
          {localTime(current.lastHeartbeatAt)}
        </Text>
      ) : null}
    </Box>
  );
}

export function QueueView({ theme, data, selected, height, filter }: ViewProps) {
  const rows = filteredQueue(data, filter);
  const columns: Column<QueueRow>[] = [
    { header: 'PR', width: 6, value: (r) => `#${r.prNumber}` },
    { header: 'Base', width: 10, value: (r) => r.baseBranch },
    { header: 'Mode', width: 15, value: (r) => r.mode },
    { header: 'Status', width: 12, value: (r) => r.status, color: (r) => stateColor(theme, r.status) },
    {
      header: 'Checks',
      width: 9,
      value: (r) => r.checks ?? 'unknown',
      color: (r) => stateColor(theme, r.checks ?? ''),
    },
    { header: 'Base/Head', width: 17, value: (r) => `${shortSha(r.baseSha)}/${shortSha(r.headSha)}` },
    { header: 'Stack', width: 8, value: (r) => (r.stackId ? `${r.stackId.slice(-4)}:${r.stackOrder}` : '—') },
    { header: 'Title', width: 36, value: (r) => r.prTitle },
  ];
  const current = rows[selected];
  return (
    <Box flexDirection="column">
      <Table
        theme={theme}
        columns={columns}
        rows={rows}
        selected={selected}
        height={Math.max(3, height - 5)}
        empty="Integration queue is empty."
      />
      {current ? (
        <Box flexDirection="column">
          <Text bold>Blockers for #{current.prNumber}:</Text>
          {current.blockers.length === 0 ? <Text color={theme.ok}>none recorded</Text> : null}
          {current.blockers.slice(0, 3).map((b) => (
            <Text key={b.code} color={theme.warn}>
              {b.code}: {b.message}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

export function ContextView(props: {
  theme: Theme;
  result: ContextSearchResult | null;
  query: string;
  selected: number;
  height: number;
  busy: boolean;
}) {
  const { theme, result } = props;
  const columns: Column<ContextHit>[] = [
    { header: 'Score', width: 6, value: (h) => h.score.toFixed(2) },
    { header: 'Location', width: 42, value: (h) => `${h.path}:${h.startLine}-${h.endLine}` },
    { header: 'Symbol', width: 18, value: (h) => h.symbol ?? '—' },
    { header: 'Snippet', width: 50, value: (h) => h.snippet },
  ];
  return (
    <Box flexDirection="column">
      <Text>
        Query: <Text color={theme.accent}>{props.query || '(press / to search)'}</Text>
        {props.busy ? ' searching…' : ''}
      </Text>
      {result ? (
        <Text color={theme.muted}>
          commit {shortSha(result.commitSha)} · retrieved {localTime(result.retrievedAt)} · ~{result.tokenEstimate}{' '}
          tokens
          {result.warnings.length ? ` · ${result.warnings.join('; ')}` : ''}
        </Text>
      ) : null}
      <Table
        theme={theme}
        columns={columns}
        rows={result?.hits ?? []}
        selected={props.selected}
        height={Math.max(3, props.height - 2)}
        empty="No results."
      />
    </Box>
  );
}

export function EventsView(props: {
  theme: Theme;
  events: CrewEvent[];
  selected: number;
  height: number;
  follow: boolean;
  filter: string;
}) {
  const rows = props.events.filter((e) => matches(props.filter, e.type, e.taskId, e.prId, e.actor.id, e.correlationId));
  const columns: Column<CrewEvent>[] = [
    { header: 'Seq', width: 7, value: (e) => String(e.seq) },
    { header: 'Time', width: 20, value: (e) => localTime(e.at) },
    { header: 'Type', width: 26, value: (e) => e.type },
    { header: 'Actor', width: 18, value: (e) => `${e.actor.kind}:${e.actor.id}` },
    { header: 'Task', width: 9, value: (e) => e.taskId ?? '—' },
    { header: 'Correlation', width: 14, value: (e) => e.correlationId.slice(-12) },
    { header: 'Payload', width: 40, value: (e) => JSON.stringify(e.payload) },
  ];
  return (
    <Box flexDirection="column">
      <Text color={props.theme.muted}>
        {props.follow ? 'Live (following newest)' : 'Paged history — press L to resume live'} · [ older · ] newer
      </Text>
      <Table
        theme={props.theme}
        columns={columns}
        rows={rows}
        selected={props.selected}
        height={Math.max(3, props.height - 1)}
        empty="No events."
      />
    </Box>
  );
}

function fmt(m: Measured<number>, unit = ''): string {
  return m.status === 'measured' ? `${m.value}${unit}` : 'unknown';
}

export function MetricsView({ theme, data }: ViewProps) {
  const m = data.metrics;
  if (!m) return <Text color={theme.muted}>Loading metrics…</Text>;
  return (
    <Box flexDirection="column">
      <Box>
        <Panel
          theme={theme}
          title={`Delivery (last ${Math.round((Date.parse(m.window.until) - Date.parse(m.window.since)) / 86_400_000)} days)`}
        >
          <KeyValue theme={theme} label="Merged PRs" value={m.throughput.mergedPrs} />
          <KeyValue theme={theme} label="Merged / day" value={m.throughput.perDay} />
          <KeyValue
            theme={theme}
            label="Lead time p50/p95"
            value={`${fmt(m.leadTimeHours.p50, 'h')} / ${fmt(m.leadTimeHours.p95, 'h')}`}
          />
          <KeyValue
            theme={theme}
            label="Queue wait p50/p95"
            value={`${fmt(m.queueWaitMinutes.p50, 'm')} / ${fmt(m.queueWaitMinutes.p95, 'm')}`}
          />
          <KeyValue theme={theme} label="Open PR age p50" value={fmt(m.openPrAgeHours.p50, 'h')} />
          <KeyValue
            theme={theme}
            label="WIP"
            value={
              Object.entries(m.wip)
                .map(([k, v]) => `${k}:${v}`)
                .join(' ') || '0'
            }
          />
        </Panel>
        <Panel theme={theme} title="Efficiency">
          <KeyValue theme={theme} label="Review cache hit" value={fmt(m.reviewCache.hitRatio)} />
          <KeyValue theme={theme} label="Context reduction" value={fmt(m.contextTokenReduction)} />
          <KeyValue theme={theme} label="CI min / merge" value={fmt(m.ciMinutesPerMerge)} />
          <KeyValue theme={theme} label="CI reruns" value={m.ciReruns} />
          <KeyValue theme={theme} label="Recoveries" value={m.recoveries} />
          <KeyValue
            theme={theme}
            label="Escalations"
            value={m.escalations}
            color={m.escalations ? theme.warn : undefined}
          />
        </Panel>
      </Box>
      <Panel theme={theme} title="Usage by provider / account / model (unknown is never shown as zero)">
        {m.usage.length === 0 ? <Text color={theme.muted}>No usage recorded</Text> : null}
        {m.usage.map((u) => (
          <Text key={`${u.providerId}${u.profileId}${u.model}`}>
            {`${u.providerId}/${u.profileId ?? '—'}/${u.model ?? 'default'}`.padEnd(40)} sessions {u.sessions} · in{' '}
            {fmt(u.inputTokens)} · out {fmt(u.outputTokens)} · cost{' '}
            {u.costUsd.status === 'measured' ? `$${u.costUsd.value} (${u.costSource})` : 'unknown'}
          </Text>
        ))}
      </Panel>
    </Box>
  );
}

export function StatusLine(props: { theme: Theme; data: DashboardData; message: string | null }) {
  const { theme, data } = props;
  return (
    <Box>
      <Text color={data.stale ? theme.error : theme.muted}>
        {data.stale ? `STALE — reconnecting (${data.error ?? 'unknown error'}) · ` : ''}cursor {data.cursor} · updated{' '}
        {localTime(data.loadedAt)}
      </Text>
      {props.message ? <Text color={theme.accent}> · {props.message}</Text> : null}
    </Box>
  );
}

export { StateText };
