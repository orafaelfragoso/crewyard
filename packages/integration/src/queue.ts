import type { Database } from 'bun:sqlite';
import type { CrewConfig } from '@crewyard/config';
import { type Actor, CrewError, newId, nowIso } from '@crewyard/core';
import { requestInterventionInTx } from '@crewyard/reviews';
import { all, type CrewContext, recordTransition } from '@crewyard/storage';
import { classifyPullRequest } from './eligibility.ts';
import { configFor, type PendingHook, repositoryFor, runHooks } from './env.ts';
import {
  activeCandidates,
  activeEntries,
  activeEntryForPr,
  dependenciesOf,
  entryById,
  invalidateCandidatesInTx,
  pullRequestById,
  pullRequestByNumber,
  queueById,
  queueFor,
  queuesForRepository,
  requirePullRequest,
  setEntryStatus,
} from './records.ts';
import { type RemoteFreshness, readFreshness } from './sync-state.ts';
import type {
  Blocker,
  IntegrationCandidate,
  IntegrationEnv,
  IntegrationQueue,
  PullRequestRecord,
  QueueEntry,
  QueueMode,
} from './types.ts';

export function resolveQueueMode(config: Pick<CrewConfig, 'integration'>, pr: PullRequestRecord | null): QueueMode {
  if (config.integration.mode !== 'auto') return config.integration.mode;
  return pr?.governance?.requirements?.mergeQueue ? 'github-managed' : 'crew-managed';
}

export function integrationBaseOf(pr: PullRequestRecord): string {
  return pr.governance?.integrationBase ?? pr.baseRef;
}

export function ensureQueueInTx(
  db: Database,
  input: { repositoryId: string; baseBranch: string; mode: QueueMode; capacity: number },
  at: string,
): IntegrationQueue {
  const existing = queueFor(db, input.repositoryId, input.baseBranch);
  if (existing) return existing;
  const id = newId('q');
  db.query(
    `INSERT INTO integration_queues (id, repository_id, base_branch, mode, paused, capacity, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(id, input.repositoryId, input.baseBranch, input.mode, input.capacity, at, at);
  return queueById(db, id)!;
}

const REVIVABLE: readonly QueueEntry['status'][] = ['quarantined', 'escalated'];

function retryEntryInTx(
  db: Database,
  entry: QueueEntry,
  pr: PullRequestRecord,
  at: string,
  hooks: PendingHook[],
): void {
  setEntryStatus(db, entry.id, 'waiting', at, { blockers: [] });
  db.query(`DELETE FROM failure_records WHERE subject_kind = 'pr' AND subject_id = ?`).run(pr.id);
  if (pr.taskId) {
    hooks.push({
      name: 'onQueued',
      event: {
        taskId: pr.taskId,
        prId: pr.id,
        prNumber: pr.number,
        repositoryId: pr.repositoryId,
        entryId: entry.id,
        revived: true,
      },
    });
  }
}

export interface RequestIntegrationInput {
  prId?: string;
  repositoryId?: string;
  number?: number;
  priority?: number;
  requestedBy: Actor;
}

export interface RequestIntegrationResult {
  created: boolean;
  queue: IntegrationQueue;
  entry: QueueEntry;
}

export async function requestIntegration(
  ctx: CrewContext,
  input: RequestIntegrationInput,
  env: IntegrationEnv = {},
): Promise<RequestIntegrationResult> {
  const lookup = (db: Database) => {
    if (input.prId) return requirePullRequest(db, input.prId);
    if (input.repositoryId && input.number !== undefined) {
      const pr = pullRequestByNumber(db, input.repositoryId, input.number);
      if (pr) return pr;
    }
    throw new CrewError('NOT_FOUND', 'Pull request not found', {
      suggestion: 'Pass a known prId, or run `crew pr sync` before requesting integration.',
    });
  };
  const initial = lookup(ctx.store.db);
  const repository = repositoryFor(ctx, initial.repositoryId);
  const config = configFor(ctx, env, repository.projectId);
  const priority = input.priority ?? 50;
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) {
    throw new CrewError('INVALID_INPUT', 'priority must be an integer between 0 and 100');
  }
  const at = nowIso(ctx.clock);
  const hooks: PendingHook[] = [];
  const result = ctx.store.immediate((db) => {
    const pr = lookup(db);
    if (pr.state !== 'open') {
      throw new CrewError('INVALID_TRANSITION', `Pull request #${pr.number} is ${pr.state}`, { retryable: false });
    }
    const queue = ensureQueueInTx(
      db,
      {
        repositoryId: pr.repositoryId,
        baseBranch: integrationBaseOf(pr),
        mode: resolveQueueMode(config, pr),
        capacity: config.scheduler.integration_capacity_per_branch,
      },
      at,
    );
    const existing = activeEntryForPr(db, pr.id);
    if (existing && REVIVABLE.includes(existing.status)) {
      retryEntryInTx(db, existing, pr, at, hooks);
      recordTransition(
        db,
        {
          type: 'queue.entry_retry',
          actor: input.requestedBy,
          prId: pr.id,
          taskId: pr.taskId,
          projectId: repository.projectId,
          payload: {
            entryId: existing.id,
            from: existing.status,
            to: 'waiting',
            reason: 'integration requested again',
          },
        },
        { action: 'queue.retry', input: { prId: pr.id }, decision: 'waiting' },
        at,
      );
      return { created: false, queue, entry: entryById(db, existing.id)! };
    }
    if (existing) return { created: false, queue, entry: existing };
    const id = newId('qe');
    const risk = classifyPullRequest(config, pr).risk;
    db.query(
      `INSERT INTO queue_entries (id, queue_id, pr_id, priority, risk, stack_id, stack_order, status, blockers, attempts, requested_by, enqueued_at, progressing_since, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', '[]', 0, ?, ?, ?, ?)`,
    ).run(
      id,
      queue.id,
      pr.id,
      priority,
      risk,
      pr.stackId,
      pr.stackOrder,
      `${input.requestedBy.kind}:${input.requestedBy.id}`,
      at,
      at,
      at,
    );
    recordTransition(
      db,
      {
        type: 'queue.entry_requested',
        actor: input.requestedBy,
        prId: pr.id,
        taskId: pr.taskId,
        projectId: repository.projectId,
        payload: { entryId: id, queueId: queue.id, number: pr.number, priority, risk, mode: queue.mode },
      },
      { action: 'queue.request', input: { prId: pr.id, priority }, decision: 'queued' },
      at,
    );
    if (pr.taskId) {
      hooks.push({
        name: 'onQueued',
        event: { taskId: pr.taskId, prId: pr.id, prNumber: pr.number, repositoryId: pr.repositoryId, entryId: id },
      });
    }
    return { created: true, queue, entry: entryById(db, id)! };
  });
  await runHooks(ctx, env.hooks, hooks);
  return result;
}

export function setQueuePaused(ctx: CrewContext, queueId: string, paused: boolean, actor: Actor): IntegrationQueue {
  const at = nowIso(ctx.clock);
  return ctx.store.immediate((db) => {
    const queue = queueById(db, queueId);
    if (!queue) throw new CrewError('NOT_FOUND', `Queue not found: ${queueId}`);
    db.query('UPDATE integration_queues SET paused = ?, updated_at = ? WHERE id = ?').run(paused ? 1 : 0, at, queueId);
    recordTransition(
      db,
      { type: paused ? 'queue.paused' : 'queue.resumed', actor, payload: { queueId, baseBranch: queue.baseBranch } },
      { action: paused ? 'queue.pause' : 'queue.resume', input: { queueId }, decision: 'accepted' },
      at,
    );
    return queueById(db, queueId)!;
  });
}

export type EntryAction = 'quarantine' | 'escalate' | 'retry' | 'remove';

export async function updateQueueEntry(
  ctx: CrewContext,
  input: { entryId: string; action: EntryAction; reason: string },
  actor: Actor,
  env: IntegrationEnv = {},
): Promise<QueueEntry> {
  const at = nowIso(ctx.clock);
  const hooks: PendingHook[] = [];
  const entry = ctx.store.immediate((db) => {
    const entry = entryById(db, input.entryId);
    if (!entry) throw new CrewError('NOT_FOUND', `Queue entry not found: ${input.entryId}`);
    if (entry.status === 'merged' || entry.status === 'removed') {
      throw new CrewError('INVALID_TRANSITION', `Entry is already ${entry.status}`, { retryable: false });
    }
    if (entry.status === 'merging' && input.action !== 'escalate') {
      throw new CrewError('INVALID_TRANSITION', 'Entry has a merge in flight; wait for reconciliation', {
        retryable: true,
      });
    }
    const pr = requirePullRequest(db, entry.prId);
    const status =
      input.action === 'quarantine'
        ? 'quarantined'
        : input.action === 'escalate'
          ? 'escalated'
          : input.action === 'remove'
            ? 'removed'
            : 'waiting';
    if (input.action === 'retry') {
      retryEntryInTx(db, entry, pr, at, hooks);
    } else {
      const blockers: Blocker[] = [{ code: status.toUpperCase(), source: 'queue', message: input.reason }];
      setEntryStatus(db, entry.id, status, at, { blockers });
      invalidateCandidatesInTx(db, { prId: pr.id }, `entry_${status}`, actor, at);
    }
    if (input.action === 'escalate') {
      const project = all<{ project_id: string }>(
        db,
        'SELECT project_id FROM repositories WHERE id = ?',
        pr.repositoryId,
      )[0]!;
      requestInterventionInTx(
        db,
        {
          projectId: project.project_id,
          title: `PR #${pr.number} escalated`,
          reasons: [input.reason],
          prId: pr.id,
          taskId: pr.taskId,
        },
        actor,
        at,
      );
      if (pr.taskId) {
        hooks.push({
          name: 'onEscalated',
          event: {
            taskId: pr.taskId,
            prId: pr.id,
            prNumber: pr.number,
            repositoryId: pr.repositoryId,
            reason: input.reason,
            failureFingerprint: null,
          },
        });
      }
    }
    recordTransition(
      db,
      {
        type: `queue.entry_${input.action}`,
        actor,
        prId: pr.id,
        taskId: pr.taskId,
        payload: { entryId: entry.id, from: entry.status, to: status, reason: input.reason },
      },
      { action: `queue.${input.action}`, input, decision: status },
      at,
    );
    return entryById(db, entry.id)!;
  });
  await runHooks(ctx, env.hooks, hooks);
  return entry;
}

export interface OrderItem {
  entry: QueueEntry;
  pr: PullRequestRecord;
  eligible: boolean;
  dependsOn: string[];
}

export function orderQueue(items: readonly OrderItem[], now: Date, maxAgeMinutes: number): OrderItem[] {
  const byPr = new Map(items.map((i) => [i.pr.id, i]));
  const unblockValue = new Map<string, number>();
  for (const item of items) {
    for (const dep of item.dependsOn) unblockValue.set(dep, (unblockValue.get(dep) ?? 0) + 1);
  }
  const aged = (item: OrderItem) => now.getTime() - Date.parse(item.entry.enqueuedAt) > maxAgeMinutes * 60_000;
  const compare = (a: OrderItem, b: OrderItem) =>
    Number(b.eligible) - Number(a.eligible) ||
    Number(aged(b)) - Number(aged(a)) ||
    b.entry.priority - a.entry.priority ||
    a.entry.attempts - b.entry.attempts ||
    (unblockValue.get(b.pr.id) ?? 0) - (unblockValue.get(a.pr.id) ?? 0) ||
    a.entry.enqueuedAt.localeCompare(b.entry.enqueuedAt) ||
    a.entry.id.localeCompare(b.entry.id);
  const placed = new Set<string>();
  const result: OrderItem[] = [];
  const remaining = [...items];
  while (remaining.length > 0) {
    const ready = remaining.filter((i) => i.dependsOn.every((d) => placed.has(d) || !byPr.has(d)));
    const pool = ready.length > 0 ? ready : remaining;
    pool.sort(compare);
    const next = pool[0]!;
    result.push(next);
    placed.add(next.pr.id);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return result;
}

export function unmergedDependencies(db: Database, prId: string): string[] {
  return dependenciesOf(db, prId)
    .filter((d) => pullRequestById(db, d.prId)?.state !== 'merged')
    .map((d) => d.prId);
}

export interface QueueStatusEntry {
  position: number;
  entry: QueueEntry;
  pr: { id: string; number: number; title: string; headSha: string; taskId: string | null; url: string | null };
}

export interface QueueStatus {
  queue: IntegrationQueue;
  entries: QueueStatusEntry[];
  candidates: IntegrationCandidate[];
  remote: RemoteFreshness;
}

export function queueStatusFor(db: Database, queue: IntegrationQueue, now: Date, maxAgeMinutes: number): QueueStatus {
  const items: OrderItem[] = activeEntries(db, queue.id)
    .map((entry) => ({ entry, pr: pullRequestById(db, entry.prId) }))
    .filter((i): i is { entry: QueueEntry; pr: PullRequestRecord } => i.pr !== null)
    .map(({ entry, pr }) => ({
      entry,
      pr,
      eligible: entry.status === 'eligible',
      dependsOn: unmergedDependencies(db, pr.id),
    }));
  return {
    queue,
    entries: orderQueue(items, now, maxAgeMinutes).map((item, index) => ({
      position: index + 1,
      entry: item.entry,
      pr: {
        id: item.pr.id,
        number: item.pr.number,
        title: item.pr.title,
        headSha: item.pr.headSha,
        taskId: item.pr.taskId,
        url: item.pr.url,
      },
    })),
    candidates: activeCandidates(db, queue.id),
    remote: readFreshness(db, queue.repositoryId),
  };
}

export function getQueueStatus(
  ctx: CrewContext,
  selector: { queueId?: string; repositoryId?: string; baseBranch?: string; prId?: string },
  env: IntegrationEnv = {},
): QueueStatus {
  const db = ctx.store.db;
  let queue: IntegrationQueue | null = null;
  if (selector.queueId) queue = queueById(db, selector.queueId);
  else if (selector.prId) {
    const entry = activeEntryForPr(db, selector.prId);
    queue = entry ? queueById(db, entry.queueId) : null;
  } else if (selector.repositoryId) {
    const repository = repositoryFor(ctx, selector.repositoryId);
    queue = queueFor(db, selector.repositoryId, selector.baseBranch ?? repository.defaultBase);
  }
  if (!queue) throw new CrewError('NOT_FOUND', 'Integration queue not found');
  const repository = repositoryFor(ctx, queue.repositoryId);
  const config = configFor(ctx, env, repository.projectId);
  return queueStatusFor(db, queue, ctx.clock.now(), config.scheduler.max_queue_age_minutes);
}

export function listQueues(ctx: CrewContext, repositoryId?: string): IntegrationQueue[] {
  if (repositoryId) return queuesForRepository(ctx.store.db, repositoryId);
  return all<{ id: string }>(ctx.store.db, 'SELECT id FROM integration_queues ORDER BY repository_id, base_branch').map(
    (r) => queueById(ctx.store.db, r.id)!,
  );
}
