import { integrationEnv, projectForRepositoryPath, publishTask, reviewPullRequest } from '@crewyard/application';
import { CrewError } from '@crewyard/core';
import {
  acknowledgeDivergence,
  decideMergeApproval,
  explainPullRequest,
  getCandidate,
  getQueueStatus,
  importPullRequests,
  integrationStatus,
  listCandidates,
  listPullRequests,
  listQueues,
  processIntegrationOutbox,
  queueTick,
  requestIntegration,
  setQueuePaused,
  showPullRequest,
  syncRepository,
  updateQueueEntry,
} from '@crewyard/integration';
import {
  getReview,
  invalidateReviews,
  listFindings,
  listReviews,
  type ReviewType,
  updateFindingStatus,
} from '@crewyard/reviews';
import type { CrewContext } from '@crewyard/storage';
import { acquireLeadership } from '@crewyard/storage';
import type { Command } from 'commander';
import { confirm, emit, emitChange, keyValues, table } from '../output.ts';
import { action, mutate, operatorActor, withConfirmOption, withMutationOptions } from '../program.ts';

async function repo(ctx: CrewContext, opts: { project?: string }) {
  return (await projectForRepositoryPath(ctx, opts.project)).repository;
}

async function prId(ctx: CrewContext, opts: { project?: string }, number: string): Promise<string> {
  const r = await repo(ctx, opts);
  return showPullRequest(ctx, { repositoryId: r.id, number: Number(number) }).id;
}

function operatorLeader(ctx: CrewContext, repositoryId: string, base: string): string {
  const id = `cli:${process.pid}`;
  const lease = acquireLeadership(ctx.store, `integration:${repositoryId}:${base}`, id, 120);
  if (!lease) {
    throw new CrewError(
      'CONFLICT',
      'Another integration controller (normally `crew service`) holds leadership for this branch',
      {
        suggestion: 'Let the running service process the queue, or stop it before running a manual tick.',
      },
    );
  }
  return id;
}

export function registerIntegrationCommands(program: Command): void {
  program
    .command('sync')
    .description('synchronize PRs, reviews, checks, rules and merge state from GitHub')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        emit(opts, await syncRepository(ctx, r.id, integrationEnv(ctx)), (s) => JSON.stringify(s, null, 2));
      }),
    );

  const pr = program.command('pr').description('pull requests tracked by Crewyard');
  pr.command('import')
    .description('import existing open PRs and classify merge candidates, blockers and stacks')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        const result = await importPullRequests(ctx, r.id, integrationEnv(ctx));
        emit(opts, result, (d) => [
          table(
            d.pullRequests.map((p) => ({
              pr: p.number,
              risk: p.risk,
              eligible: p.eligible,
              stack: p.stackId ? `${p.stackId}:${p.stackOrder}` : null,
              blockers: p.blockers.map((b) => b.code).join(','),
            })),
          ),
          `low-risk candidates: ${d.lowRiskCandidates.join(', ') || '—'} · blocked: ${d.blocked.join(', ') || '—'}`,
        ]);
      }),
    );
  pr.command('list')
    .option('--state <state>', 'open | closed | merged', 'open')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        emit(opts, listPullRequests(ctx, { repositoryId: r.id, state: opts.state as 'open' }), (rows) =>
          table(
            rows.map((p) => ({
              pr: p.number,
              task: p.taskId,
              state: p.state,
              checks: p.checksState,
              review: p.reviewDecision,
              head: p.headSha.slice(0, 10),
              title: p.title,
            })),
          ),
        );
      }),
    );
  pr.command('show <number>').action(
    action(async (ctx, opts, number: string) => {
      const id = await prId(ctx, opts, number);
      emit(
        opts,
        {
          pullRequest: showPullRequest(ctx, { prId: id }),
          explanation: explainPullRequest(ctx, id, integrationEnv(ctx)),
        },
        (d) => JSON.stringify(d, null, 2),
      );
    }),
  );
  pr.command('sync <number>').action(
    action(async (ctx, opts, number: string) => {
      const r = await repo(ctx, opts);
      emit(opts, await syncRepository(ctx, r.id, integrationEnv(ctx), { numbers: [Number(number)] }), (s) =>
        JSON.stringify(s, null, 2),
      );
    }),
  );
  withConfirmOption(
    pr
      .command('submit')
      .description('push a handed-off task branch and open its PR (operator authorization for assisted mode)')
      .requiredOption('--task <taskId>')
      .option('--no-review', 'skip Crewyard review')
      .option('--no-enqueue', 'do not request integration'),
  ).action(
    action(async (ctx, opts) => {
      const r = await repo(ctx, opts);
      await confirm(opts, `Push ${String(opts.task)} and open a pull request on ${r.remoteOwner}/${r.remoteName}?`);
      const result = await publishTask(ctx, {
        taskId: String(opts.task),
        actor: operatorActor(),
        leaderId: `cli:${process.pid}`,
        review: opts.review !== false,
        enqueue: opts.enqueue !== false,
      });
      emit(
        opts,
        result,
        (d) =>
          `${d.taskId}: ${d.pullRequest ? `PR #${d.pullRequest.number} ${d.pullRequest.url ?? ''}` : `PR ${d.operationStatus}`}${d.queued ? ' · queued' : ''}`,
      );
    }),
  );
  withMutationOptions(
    pr
      .command('approve <number>')
      .description('authorize Crewyard to merge this PR head (assisted mode)')
      .option('--reject'),
  ).action(
    action(async (ctx, opts, number: string) => {
      const id = await prId(ctx, opts, number);
      const result = await mutate(
        ctx,
        opts,
        `${opts.reject ? 'Reject' : 'Approve'} merging PR #${number} at its current head?`,
        (c) => decideMergeApproval(c, { prId: id, approved: !opts.reject }, operatorActor()),
      );
      emitChange(opts, result, (d) => `${d.subjectId}: ${d.status}`);
    }),
  );
  withMutationOptions(
    pr
      .command('acknowledge <number>')
      .description('accept a branch change made outside Crewyard so the PR can integrate at its current head'),
  ).action(
    action(async (ctx, opts, number: string) => {
      const id = await prId(ctx, opts, number);
      const result = await mutate(
        ctx,
        opts,
        `Accept the current head of PR #${number} as changed outside Crewyard?`,
        (c) => acknowledgeDivergence(c, id, operatorActor(), integrationEnv(c)),
      );
      emitChange(opts, result, (d) => `PR #${d.number}: acknowledged at ${d.headSha}`);
    }),
  );

  const review = program.command('review').description('evidence-fingerprinted reviews and findings');
  review
    .command('request <number>')
    .option('--type <types>', 'code,security,integration')
    .option('--force', 're-review even when cached evidence matches')
    .action(
      action(async (ctx, opts, number: string) => {
        const id = await prId(ctx, opts, number);
        const result = await reviewPullRequest(
          ctx,
          {
            prId: id,
            ...(opts.type ? { types: String(opts.type).split(',') as ReviewType[] } : {}),
            ...(opts.force ? { force: true } : {}),
          },
          integrationEnv(ctx),
        );
        emit(opts, result, (d) =>
          table(
            d.outcomes.map((o) => ({
              type: o.reviewType,
              decision: o.decision,
              invoked: o.reviewerInvoked,
              status: o.review?.status ?? null,
              error: o.error,
            })),
          ),
        );
      }),
    );
  review.command('show <numberOrReviewId>').action(
    action(async (ctx, opts, ref: string) => {
      if (ref.startsWith('rev_')) return emit(opts, getReview(ctx, ref), (r) => JSON.stringify(r, null, 2));
      const id = await prId(ctx, opts, ref);
      emit(opts, { reviews: listReviews(ctx, { prId: id }), findings: listFindings(ctx, { prId: id }) }, (d) =>
        [
          table(
            d.reviews.map((r) => ({
              id: r.id,
              type: r.reviewType,
              status: r.status,
              commit: r.commitSha.slice(0, 10),
              reviewer: r.reviewerIdentity,
              reused: r.reusedFrom,
            })),
          ),
          table(
            d.findings.map((f) => ({
              id: f.id,
              severity: f.severity,
              status: f.status,
              location: f.path ? `${f.path}:${f.startLine ?? ''}` : null,
              reason: f.reason,
            })),
          ),
        ].join('\n\n'),
      );
    }),
  );
  review
    .command('invalidate <number>')
    .requiredOption('--reason <text>')
    .action(
      action(async (ctx, opts, number: string) => {
        const id = await prId(ctx, opts, number);
        emit(
          opts,
          invalidateReviews(ctx, { prId: id, reason: String(opts.reason) }, operatorActor()),
          (ids) => `invalidated ${ids.length} review(s)`,
        );
      }),
    );
  review
    .command('finding <findingId> <status>')
    .description('set a finding to accepted | dismissed | resolved | open')
    .option('--note <text>')
    .action(
      action((ctx, opts, findingId: string, status: string) =>
        emit(
          opts,
          updateFindingStatus(
            ctx,
            { findingId, status: status as never, ...(opts.note ? { note: String(opts.note) } : {}) },
            operatorActor(),
          ),
          (f) => `${f.id} ${f.status}`,
        ),
      ),
    );

  const queue = program.command('queue').description('integration queue');
  queue.command('list').action(
    action(async (ctx, opts) => {
      const r = await repo(ctx, opts);
      emit(opts, listQueues(ctx, r.id), (rows) => table(rows as unknown as Record<string, unknown>[]));
    }),
  );
  queue
    .command('status')
    .option('--base <branch>')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        emit(
          opts,
          getQueueStatus(
            ctx,
            { repositoryId: r.id, baseBranch: (opts.base as string | undefined) ?? r.defaultBase },
            integrationEnv(ctx),
          ),
          (s) => JSON.stringify(s, null, 2),
        );
      }),
    );
  queue
    .command('explain')
    .requiredOption('--pr <number>')
    .action(
      action(async (ctx, opts) => {
        const id = await prId(ctx, opts, String(opts.pr));
        emit(opts, explainPullRequest(ctx, id, integrationEnv(ctx)), (e) => JSON.stringify(e, null, 2));
      }),
    );
  queue
    .command('add <number>')
    .description('request integration for a PR (idempotent)')
    .option('--priority <n>', 'priority', Number)
    .action(
      action(async (ctx, opts, number: string) => {
        const id = await prId(ctx, opts, number);
        const result = await requestIntegration(
          ctx,
          {
            prId: id,
            ...(opts.priority !== undefined ? { priority: Number(opts.priority) } : {}),
            requestedBy: operatorActor(),
          },
          integrationEnv(ctx),
        );
        emit(opts, result, (d) => `${d.created ? 'queued' : 'already queued'}: ${d.entry.id} (${d.queue.mode})`);
      }),
    );
  queue
    .command('tick')
    .description('run one bounded integration cycle (requires leadership; fails if the service holds it)')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        const leaderId = operatorLeader(ctx, r.id, r.defaultBase);
        const env = integrationEnv(ctx);
        const outbox = await processIntegrationOutbox(ctx, { leaderId, env });
        const tick = await queueTick(ctx, r.id, { leaderId, env, sync: true });
        emit(opts, { outbox, tick }, (d) => JSON.stringify(d, null, 2));
      }),
    );
  for (const [name, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    queue.command(`${name} [queueId]`).action(
      action(async (ctx, opts, queueId?: string) => {
        const r = await repo(ctx, opts);
        const id = queueId ?? listQueues(ctx, r.id).find((q) => q.baseBranch === r.defaultBase)?.id;
        if (!id) throw new CrewError('NOT_FOUND', 'No integration queue exists yet for the base branch');
        emit(opts, setQueuePaused(ctx, id, paused, operatorActor()), (q) => `${q.id} ${paused ? 'paused' : 'resumed'}`);
      }),
    );
  }
  for (const act of ['retry', 'quarantine', 'escalate', 'remove'] as const) {
    withMutationOptions(queue.command(`${act} <entryId>`).requiredOption('--reason <text>')).action(
      action(async (ctx, opts, entryId: string) => {
        if (act === 'remove') await confirm(opts, `Remove queue entry ${entryId}?`);
        await updateQueueEntry(
          ctx,
          { entryId, action: act, reason: String(opts.reason) },
          operatorActor(),
          integrationEnv(ctx),
        );
        emit(opts, { entryId, action: act }, () => `${entryId}: ${act}`);
      }),
    );
  }

  const integration = program.command('integration').description('integration candidates and validation');
  integration.command('status').action(
    action(async (ctx, opts) => {
      const r = await repo(ctx, opts);
      emit(opts, integrationStatus(ctx, r.id, integrationEnv(ctx)), (s) => JSON.stringify(s, null, 2));
    }),
  );
  integration
    .command('candidate [candidateId]')
    .description('show a candidate or list recent candidates for the base-branch queue')
    .action(
      action(async (ctx, opts, candidateId?: string) => {
        if (candidateId) return emit(opts, getCandidate(ctx, candidateId), (c) => JSON.stringify(c, null, 2));
        const r = await repo(ctx, opts);
        const q = listQueues(ctx, r.id).find((x) => x.baseBranch === r.defaultBase);
        emit(opts, q ? listCandidates(ctx, q.id) : [], (rows) =>
          table(
            rows.map((c) => ({
              id: c.id,
              status: c.status,
              base: c.baseSha.slice(0, 10),
              validated: c.integrationValidated,
              reason: c.invalidReason,
            })),
          ),
        );
      }),
    );
  integration
    .command('validate')
    .description('build and validate the next candidate now (one leader-only queue cycle)')
    .action(
      action(async (ctx, opts) => {
        const r = await repo(ctx, opts);
        const leaderId = operatorLeader(ctx, r.id, r.defaultBase);
        const result = await queueTick(ctx, r.id, { leaderId, env: integrationEnv(ctx), sync: true, maxCandidates: 1 });
        emit(opts, result, (d) => keyValues(d as unknown as Record<string, unknown>));
      }),
    );
}
