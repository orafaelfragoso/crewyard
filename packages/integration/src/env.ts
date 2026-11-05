import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CrewConfig } from '@crewyard/config';
import {
  type Actor,
  addSeconds,
  CrewError,
  ensureDir,
  fingerprint,
  git,
  newId,
  nowIso,
  redact,
  sha256,
  writeFileAtomic,
} from '@crewyard/core';
import {
  assertRemoteMatches,
  type ConditionalCache,
  GitHubClient,
  type GitHubClientOptions,
  ghTokenProvider,
  type RepositoryCoordinates,
  type TokenProvider,
} from '@crewyard/github';
import { getProject, getRepository, projectConfig, type Repository } from '@crewyard/projects';
import {
  assertOutboxClaim,
  type ClaimedOutboxOperation,
  type CrewContext,
  claimDueOutbox,
  completeOutbox,
  enqueueOutbox,
  one,
  recordTransition,
  renewOutboxClaim,
} from '@crewyard/storage';
import type { GitHubClientFactory, IntegrationEnv, TaskHooks } from './types.ts';

export const CREW_INTEGRATION_ACTOR: Actor = { kind: 'service', id: 'integration' };

export function coordinates(repository: Repository): RepositoryCoordinates {
  if (!repository.remoteOwner || !repository.remoteName) {
    throw new CrewError('INVALID_INPUT', `Repository ${repository.id} has no GitHub remote`, {
      suggestion: 'Add a GitHub `origin` remote and run `crew project sync`.',
    });
  }
  return { host: repository.remoteHost ?? 'github.com', owner: repository.remoteOwner, name: repository.remoteName };
}

export function syncStateCache(ctx: CrewContext, repositoryId: string): ConditionalCache {
  const dir = join(ctx.dirs.data, 'cache', 'github', repositoryId);
  const fileFor = (bodySha: string) => join(dir, `${bodySha}.json`);
  const stateKey = (key: string) => `github:etag:${repositoryId}:${sha256(key).slice(0, 40)}`;
  return {
    get(key) {
      const row = one<{ etag: string | null; cache_body_sha: string | null }>(
        ctx.store.db,
        'SELECT etag, cache_body_sha FROM sync_state WHERE key = ?',
        stateKey(key),
      );
      if (!row?.etag || !row.cache_body_sha || !/^[a-f0-9]{64}$/.test(row.cache_body_sha)) return null;
      const file = fileFor(row.cache_body_sha);
      if (!existsSync(file)) return null;
      try {
        const body = readFileSync(file, 'utf8');
        if (sha256(body) !== row.cache_body_sha) return null;
        return { etag: row.etag, body: JSON.parse(body) as unknown };
      } catch {
        return null;
      }
    },
    set(key, entry) {
      ensureDir(dir);
      const body = JSON.stringify(entry.body);
      if (body === undefined) throw new CrewError('INVALID_INPUT', 'Conditional response body must be JSON');
      const bodySha = sha256(body);
      const file = fileFor(bodySha);
      if (!existsSync(file)) writeFileAtomic(file, body, { mode: 0o600 });
      const at = nowIso(ctx.clock);
      ctx.store.immediate((db) => {
        db.query(
          `INSERT INTO sync_state (key, etag, cache_body_sha, last_success_at, last_attempt_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, cache_body_sha = excluded.cache_body_sha, last_success_at = excluded.last_success_at, last_attempt_at = excluded.last_attempt_at`,
        ).run(stateKey(key), entry.etag, bodySha, at, at);
      });
    },
  };
}

export interface ClientFactoryOptions extends Partial<Omit<GitHubClientOptions, 'repository' | 'token' | 'cache'>> {
  token?: TokenProvider;
  conditional?: boolean;
}

export function createClientFactory(ctx: CrewContext, options: ClientFactoryOptions = {}): GitHubClientFactory {
  const clients = new Map<string, GitHubClient>();
  return (repository) => {
    const existing = clients.get(repository.id);
    if (existing) return existing;
    const repo = coordinates(repository);
    const { token, conditional, ...rest } = options;
    const client = new GitHubClient({
      ...rest,
      repository: repo,
      token:
        token ??
        ghTokenProvider({
          host: repo.host,
          configDir: repository.ghConfigDir,
          signal: ctx.execution?.signal,
          onSpawn: ctx.execution?.onSpawn,
        }),
      ...(conditional === false ? {} : { cache: syncStateCache(ctx, repository.id) }),
    });
    clients.set(repository.id, client);
    return client;
  };
}

export function repositoryFor(ctx: CrewContext, repositoryId: string): Repository {
  return getRepository(ctx, repositoryId);
}

export function configFor(ctx: CrewContext, env: IntegrationEnv, projectId: string): CrewConfig {
  return env.config ?? projectConfig(ctx, projectId);
}

export function autonomyFor(ctx: CrewContext, projectId: string) {
  return getProject(ctx, projectId).autonomy;
}

export async function configuredRemoteUrl(repoPath: string, remote = 'origin'): Promise<string | null> {
  const result = await git(repoPath, ['config', '--get', `remote.${remote}.url`], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function clientFor(ctx: CrewContext, env: IntegrationEnv, repository: Repository): Promise<GitHubClient> {
  const remoteUrl = env.remoteUrl
    ? await env.remoteUrl(repository)
    : await configuredRemoteUrl(repository.canonicalPath);
  assertRemoteMatches(coordinates(repository), remoteUrl);
  return (env.github ?? createClientFactory(ctx))(repository);
}

export function leadershipScope(repositoryId: string, baseBranch: string): string {
  return `integration:${repositoryId}:${baseBranch}`;
}

export type PendingHook = {
  [K in keyof TaskHooks]-?: { name: K; event: Parameters<NonNullable<TaskHooks[K]>>[0] };
}[keyof TaskHooks];

export const INTEGRATION_HOOK_KIND = 'integration.hook';

export function hookIdempotencyKey(call: PendingHook): string {
  return `integration-hook:${fingerprint(call)}`;
}

type HookOutcome = Parameters<typeof completeOutbox>[2];

export async function processIntegrationHook(
  ctx: CrewContext,
  hooks: TaskHooks | undefined,
  op: ClaimedOutboxOperation,
): Promise<HookOutcome['status']> {
  const call = op.intent as unknown as PendingHook;
  const pr = one<{
    state: string;
    head_sha: string;
    expected_remote_head: string | null;
    merge_commit_sha: string | null;
  }>(
    ctx.store.db,
    'SELECT state, head_sha, expected_remote_head, merge_commit_sha FROM pull_requests WHERE id = ?',
    call.event.prId,
  );
  const entry = one<{ id: string; status: string }>(
    ctx.store.db,
    "SELECT id, status FROM queue_entries WHERE pr_id = ? AND status NOT IN ('removed', 'merged') ORDER BY enqueued_at DESC LIMIT 1",
    call.event.prId,
  );
  const task = call.event.taskId
    ? one<{ state: string }>(ctx.store.db, 'SELECT state FROM tasks WHERE id = ?', call.event.taskId)
    : null;
  const observed =
    call.name === 'onMerged' &&
    pr?.state === 'merged' &&
    pr.merge_commit_sha === call.event.mergeCommitSha &&
    task?.state === 'DONE';
  const superseded =
    !pr ||
    (call.name !== 'onMerged' && pr.state !== 'open') ||
    (call.name === 'onMerged' && (pr.state !== 'merged' || pr.merge_commit_sha !== call.event.mergeCommitSha)) ||
    (call.name === 'onReviewRequired' && pr.head_sha !== call.event.headSha) ||
    (call.name === 'onRemoteHeadAccepted' && pr.expected_remote_head !== call.event.headSha) ||
    (call.name === 'onQueued' && entry?.id !== call.event.entryId) ||
    (call.name === 'onValidating' &&
      one<{ status: string }>(
        ctx.store.db,
        'SELECT status FROM integration_candidates WHERE id = ?',
        call.event.candidateId,
      )?.status !== 'validating') ||
    (call.name === 'onBlocked' && entry?.status !== 'blocked') ||
    (call.name === 'onEscalated' && entry?.status !== 'escalated') ||
    (call.name === 'onRevisionRequired' && entry?.status !== 'blocked');
  let outcome: HookOutcome;
  const renewal = setInterval(() => {
    try {
      renewOutboxClaim(ctx.store, op, 120);
    } catch (error) {
      ctx.logger.warn('hook claim renewal failed', { operationId: op.operationId, error: String(error) });
    }
  }, 40_000);
  try {
    ctx.store.immediate((db) => assertOutboxClaim(db, op, nowIso(ctx.clock)));
    if (observed || superseded) {
      outcome = {
        status: 'succeeded',
        remoteCorrelation: { reconciled: true, disposition: observed ? 'already_applied' : 'superseded' },
      };
    } else {
      const fn = hooks?.[call.name] as ((event: PendingHook['event']) => void | Promise<void>) | undefined;
      if (!fn) throw new CrewError('UNAVAILABLE', `Task hook ${call.name} is not configured`, { retryable: true });
      await fn.call(hooks, call.event);
      outcome = { status: 'succeeded', remoteCorrelation: { hook: call.name, delivered: true } };
    }
  } catch (error) {
    if (error instanceof CrewError && error.code === 'STALE_LEASE') throw error;
    const message = redact(error instanceof Error ? error.message : String(error));
    outcome =
      op.attempts >= op.maxAttempts
        ? { status: 'failed', error: message }
        : {
            status: 'retry',
            attempts: op.attempts,
            error: message,
            nextAttemptAt: addSeconds(nowIso(ctx.clock), Math.min(300, 2 ** op.attempts)),
          };
  } finally {
    clearInterval(renewal);
  }
  ctx.store.immediate((db) => {
    const at = nowIso(ctx.clock);
    completeOutbox(db, op, outcome, at);
    recordTransition(
      db,
      {
        type: outcome.status === 'succeeded' ? 'integration.hook_delivered' : 'integration.hook_failed',
        actor: CREW_INTEGRATION_ACTOR,
        taskId: call.event.taskId,
        prId: call.event.prId,
        payload: {
          hook: call.name,
          operationId: op.operationId,
          attempts: op.attempts,
          exhausted: outcome.status === 'failed',
          ...('error' in outcome ? { error: outcome.error } : {}),
        },
      },
      { action: 'integration.hook', input: { hook: call.name }, decision: outcome.status },
      at,
    );
  });
  return outcome.status;
}

export async function runHooks(ctx: CrewContext, hooks: TaskHooks | undefined, pending: PendingHook[]): Promise<void> {
  if (!hooks || pending.length === 0) return;
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    for (const call of pending) {
      if (!hooks[call.name]) continue;
      const key = hookIdempotencyKey(call);
      const existing = one<{ operation_id: string; status: string }>(
        db,
        'SELECT operation_id, status FROM outbox WHERE idempotency_key = ?',
        key,
      );
      const task = call.event.taskId
        ? one<{ state: string }>(db, 'SELECT state FROM tasks WHERE id = ?', call.event.taskId)
        : null;
      const repair =
        call.name === 'onReviewRequired' ||
        (task &&
          ((call.name === 'onMerged' && task.state !== 'DONE') ||
            (call.name === 'onQueued' && ['SUBMITTED', 'REVIEWING', 'BLOCKED', 'REVISION'].includes(task.state))));
      if (existing?.status === 'succeeded' && repair) {
        db.query(
          "UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL, remote_correlation = NULL, next_attempt_at = ?, updated_at = ? WHERE operation_id = ?",
        ).run(at, at, existing.operation_id);
        recordTransition(
          db,
          {
            type: 'integration.hook_reconciliation_requested',
            actor: CREW_INTEGRATION_ACTOR,
            prId: call.event.prId,
            taskId: call.event.taskId,
            payload: { operationId: existing.operation_id, hook: call.name, taskState: task?.state ?? null },
          },
          { action: 'integration.hook_reconcile', input: { hook: call.name }, decision: 'pending' },
          at,
        );
      }
      enqueueOutbox(
        db,
        {
          kind: INTEGRATION_HOOK_KIND,
          subjectId: call.event.prId,
          taskId: call.event.taskId,
          intent: { name: call.name, event: call.event },
          idempotencyKey: key,
          maxAttempts: 5,
        },
        at,
      );
    }
  });
  const ownerId = newId('wrk');
  for (let delivered = 0; delivered < pending.length; delivered++) {
    const op = claimDueOutbox(ctx.store, { ownerId, limit: 1, kinds: [INTEGRATION_HOOK_KIND], ttlSeconds: 120 })[0];
    if (!op) break;
    await processIntegrationHook(ctx, hooks, op);
  }
}
