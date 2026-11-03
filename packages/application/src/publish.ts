import { type Actor, CrewError, git, nowIso } from '@crewyard/core';
import {
  ACTIVE_ENTRY_STATUSES,
  setExpectedRemoteHead as expectPullRequestHead,
  type IntegrationEnv,
  listPullRequests,
  type PullRequestRecord,
  requestIntegration,
  submitPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { getProject, loadProjectConfig, primaryRepository } from '@crewyard/projects';
import { requestInterventionInTx } from '@crewyard/reviews';
import { type CrewContext, one, recordRemoteOperation, recordTransition } from '@crewyard/storage';
import { applyTransition, listApprovals, requestApprovalInTx, showTask, transitionTask } from '@crewyard/tasks';
import { collectCommits, getWorkspace, listWorkspaces, setExpectedRemoteHead } from '@crewyard/workspaces';
import { integrationEnv, reviewPullRequest } from './integration.ts';

export interface PublishResult {
  taskId: string;
  branch: string;
  headSha: string;
  pushed: boolean;
  pullRequest: PullRequestRecord | null;
  operationStatus: string;
  review: { type: string; decision: string; status: string | null; reviewerInvoked: boolean; error: string | null }[];
  queued: boolean;
  notes: string[];
}

async function remoteBranchHead(cwd: string, branch: string): Promise<string | null> {
  const result = await git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
    allowFailure: true,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new CrewError('OFFLINE', `Cannot reach origin: ${result.stderr.trim().slice(0, 300)}`, { retryable: true });
  }
  return result.stdout.trim().split(/\s+/)[0] || null;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true })).exitCode === 0;
}

function assertPublishAllowed(
  ctx: CrewContext,
  projectId: string,
  taskId: string,
  headSha: string,
  actor: Actor,
): void {
  const project = getProject(ctx, projectId);
  if (project.autonomy === 'observe') {
    throw new CrewError(
      'POLICY_DENIED',
      'Project is in observe mode: Crewyard does not publish branches or pull requests',
    );
  }
  if (project.autonomy !== 'assisted' || actor.kind === 'operator') return;
  const subjectId = `${taskId}@${headSha}`;
  const approved = listApprovals(ctx, { subjectKind: 'pr_publish', subjectId }).some((a) => a.status === 'approved');
  if (approved) return;
  ctx.store.immediate((db) =>
    requestApprovalInTx(
      db,
      {
        projectId,
        subjectKind: 'pr_publish',
        subjectId,
        reason: `Publish ${taskId} at ${headSha.slice(0, 12)} as a pull request`,
        requestedBy: actor,
      },
      nowIso(ctx.clock),
    ),
  );
  throw new CrewError('APPROVAL_REQUIRED', `Assisted mode: an operator must approve publishing ${taskId}`, {
    suggestion: `crew pr submit --task ${taskId} (as operator) or approve the pending pr_publish request.`,
  });
}

function prBody(task: ReturnType<typeof showTask>['task']): string {
  const h = task.handoff;
  return [
    `Crewyard task **${task.id}**: ${task.objective || task.title}`,
    '',
    '### Acceptance criteria',
    ...task.acceptanceCriteria.map((c) => `- [ ] ${c}`),
    '',
    '### Handoff',
    h?.summary ?? '(no summary)',
    ...(h?.testEvidence?.length
      ? [
          '',
          '### Test evidence',
          ...h.testEvidence.map((t) => `- \`${t.command}\`: ${t.status}${t.summary ? ` — ${t.summary}` : ''}`),
        ]
      : []),
    ...(h?.remainingIssues?.length ? ['', '### Remaining issues', ...h.remainingIssues.map((i) => `- ${i}`)] : []),
    '',
    '_Opened by Crewyard. GitHub branch protections and required checks remain authoritative._',
  ].join('\n');
}

export async function publishTask(
  ctx: CrewContext,
  input: {
    taskId: string;
    actor: Actor;
    leaderId: string;
    env?: IntegrationEnv;
    review?: boolean;
    enqueue?: boolean;
    background?: (work: Promise<unknown>) => void;
  },
): Promise<PublishResult> {
  const task = showTask(ctx, input.taskId).task;
  if (!['SUBMITTED', 'REVIEWING', 'REVISION', 'BLOCKED'].includes(task.state)) {
    throw new CrewError('INVALID_TRANSITION', `${task.id} is ${task.state}; only handed-off work can be published`);
  }
  const workspace = listWorkspaces(ctx, { taskId: task.id }).find((w) => w.state !== 'cleaned');
  if (!workspace) throw new CrewError('NOT_FOUND', `${task.id} has no workspace to publish`);
  const commits = await collectCommits(ctx, workspace.id);
  if (commits.commits.length === 0)
    throw new CrewError('INVALID_INPUT', `${task.id} has no commits on ${workspace.branch}`);
  const headSha = commits.headSha;
  assertPublishAllowed(ctx, task.projectId, task.id, headSha, input.actor);
  const repo = primaryRepository(ctx, task.projectId);
  const config = loadProjectConfig(ctx, task.projectId).config;
  const env = input.env ?? integrationEnv(ctx);
  const notes: string[] = [];

  const remoteHead = await remoteBranchHead(workspace.path, workspace.branch);
  const expected = getWorkspace(ctx, workspace.id).expectedRemoteHead;
  let pushed = false;
  if (remoteHead !== headSha) {
    if (remoteHead && remoteHead !== expected && !(await isAncestor(workspace.path, remoteHead, headSha))) {
      throw new CrewError(
        'HEAD_MISMATCH',
        `origin/${workspace.branch} moved to ${remoteHead.slice(0, 12)} outside Crewyard`,
        {
          details: { remoteHead, expected, local: headSha },
          suggestion: 'Inspect the external change; Crewyard never force-pushes over it.',
        },
      );
    }
    const push = await git(
      workspace.path,
      ['push', '--porcelain', 'origin', `${headSha}:refs/heads/${workspace.branch}`],
      {
        allowFailure: true,
        timeoutMs: 180_000,
      },
    );
    ctx.store.immediate((db) =>
      recordRemoteOperation(db, {
        operationId: null,
        host: 'git',
        method: 'push',
        target: `origin/${workspace.branch}`,
        request: { headSha, previous: remoteHead },
        responseStatus: push.exitCode,
        result: { stderr: push.stderr.slice(0, 2_000) },
      }),
    );
    if (push.exitCode !== 0) {
      const confirmed = await remoteBranchHead(workspace.path, workspace.branch).catch(() => null);
      if (confirmed !== headSha) {
        throw new CrewError('EXTERNAL_FAILURE', `git push failed: ${push.stderr.trim().slice(0, 500)}`, {
          retryable: true,
        });
      }
      notes.push('push reported an error but the remote already has the expected head');
    }
    pushed = true;
  }
  setExpectedRemoteHead(ctx, workspace.id, { sha: headSha, expectedPrevious: expected, actor: input.actor });

  const openPr = () => listPullRequests(ctx, { repositoryId: repo.id, taskId: task.id, state: 'open' })[0] ?? null;
  const existing = openPr();
  let pr: PullRequestRecord | null;
  let operationStatus: string;
  if (existing) {
    if (pushed) {
      expectPullRequestHead(ctx, existing.id, headSha, input.actor);
      await syncRepository(ctx, repo.id, env);
    }
    pr = openPr() ?? existing;
    operationStatus = 'reused';
    notes.push(`pull request #${existing.number} already exists; its branch was updated`);
  } else {
    const submitted = await submitPullRequest(
      ctx,
      {
        repositoryId: repo.id,
        taskId: task.id,
        headRef: workspace.branch,
        headSha,
        baseRef: task.baseBranch ?? repo.defaultBase,
        title: `${task.title} (${task.id})`,
        body: prBody(task),
        actor: input.actor,
      },
      { leaderId: input.leaderId, env },
    );
    pr = submitted.pullRequest ?? openPr();
    operationStatus = submitted.status;
  }
  ctx.store.immediate((db) =>
    recordTransition(
      db,
      {
        type: 'task.published',
        actor: input.actor,
        projectId: task.projectId,
        taskId: task.id,
        payload: { branch: workspace.branch, headSha, pushed, pr: pr?.number ?? null },
      },
      { action: 'task.publish', input: { taskId: task.id, headSha }, decision: operationStatus },
    ),
  );
  if (!pr) {
    return {
      taskId: task.id,
      branch: workspace.branch,
      headSha,
      pushed,
      pullRequest: null,
      operationStatus,
      review: [],
      queued: false,
      notes: [...notes, 'pull request creation is pending in the outbox'],
    };
  }

  const reviewing = input.review !== false && config.review.enabled;
  if (reviewing && showTask(ctx, task.id).task.state === 'SUBMITTED') {
    transitionTask(ctx, {
      taskId: task.id,
      to: 'REVIEWING',
      actor: input.actor,
      reason: `review of PR #${pr.number}`,
    });
  }
  const finish = async (published: PullRequestRecord) => {
    const review: PublishResult['review'] = [];
    if (reviewing) {
      const result = await reviewPullRequest(ctx, { prId: published.id }, env);
      for (const o of result.outcomes) {
        review.push({
          type: o.reviewType,
          decision: o.decision,
          status: o.review?.status ?? null,
          reviewerInvoked: o.reviewerInvoked,
          error: o.error,
        });
      }
    }
    let queued = false;
    const autonomy = getProject(ctx, task.projectId).autonomy;
    if (
      input.enqueue !== false &&
      (autonomy === 'guarded' || autonomy === 'autopilot' || input.actor.kind === 'operator')
    ) {
      await requestIntegration(ctx, { prId: published.id, priority: task.priority, requestedBy: input.actor }, env);
      queued = true;
    }
    return { review, queued };
  };
  const base = { taskId: task.id, branch: workspace.branch, headSha, pushed, pullRequest: pr, operationStatus };
  if (input.background) {
    input.background(finish(pr));
    return { ...base, review: [], queued: false, notes: [...notes, 'review and enqueue continue in the background'] };
  }
  return { ...base, ...(await finish(pr)), notes };
}

export function blockDivergedPublication(ctx: CrewContext, taskId: string, error: CrewError, actor: Actor): void {
  const task = showTask(ctx, taskId).task;
  const pr = listPullRequests(ctx, { taskId, state: 'open' })[0] ?? null;
  const at = nowIso(ctx.clock);
  ctx.store.immediate((db) => {
    applyTransition(
      db,
      { taskId, to: 'BLOCKED', actor, reason: 'remote branch moved outside Crewyard', blockerReason: error.message },
      at,
    );
    requestInterventionInTx(
      db,
      {
        projectId: task.projectId,
        title: `${taskId} cannot publish: its branch moved outside Crewyard`,
        reasons: [
          error.message,
          pr
            ? `Inspect the change, then run \`crew pr acknowledge ${pr.number}\` and \`crew task retry ${taskId} --reason "<why>"\``
            : `Inspect the change, then run \`crew task retry ${taskId} --reason "<why>"\``,
        ],
        prId: pr?.id ?? null,
        taskId,
      },
      actor,
      at,
    );
  });
}

export function tasksAwaitingPublication(ctx: CrewContext, projectId: string): string[] {
  const active = ACTIVE_ENTRY_STATUSES.map(() => '?').join(', ');
  return (
    ctx.store.db
      .query(
        `SELECT t.id FROM tasks t JOIN projects pj ON pj.id = t.project_id WHERE t.project_id = ? AND t.repository_id IS NOT NULL
         AND ((t.state = 'SUBMITTED'
           AND EXISTS (SELECT 1 FROM workspaces w WHERE w.task_id = t.id AND w.state <> 'cleaned'
             AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.task_id = t.id AND p.state = 'open' AND p.head_sha = w.head_sha)))
         OR (t.state = 'REVIEWING' AND pj.autonomy IN ('guarded', 'autopilot')
           AND EXISTS (SELECT 1 FROM pull_requests p WHERE p.task_id = t.id AND p.state = 'open'
             AND NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.pr_id = p.id AND q.status IN (${active})))))
         ORDER BY t.id`,
      )
      .all(projectId, ...ACTIVE_ENTRY_STATUSES) as { id: string }[]
  ).map((r) => r.id);
}

export function hasOpenPr(ctx: CrewContext, taskId: string): boolean {
  return one(ctx.store.db, `SELECT 1 FROM pull_requests WHERE task_id = ? AND state = 'open'`, taskId) !== null;
}
