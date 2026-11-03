import { afterEach, describe, expect, test } from 'bun:test';
import { CrewError } from '@crewyard/core';
import { all } from '@crewyard/storage';
import {
  addTask,
  claimTask,
  completeTask,
  decideTaskApproval,
  expireLeases,
  forceReleaseLease,
  getNextAction,
  heartbeat,
  listTasksNeedingReconciliation,
  reconcileExpiredLease,
  releaseLease,
  reportBlocker,
  setTaskPaused,
  showTask,
  startTask,
  submitWork,
  transitionTask,
} from '@crewyard/tasks';
import { createTestContext, ManualClock, type TestContext } from '../../helpers/index.ts';
import { agent, operator, seedProject, testConfig } from './fixtures.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const config = testConfig();

function errorOf(fn: () => unknown): CrewError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CrewError) return error;
    throw error;
  }
  throw new Error('expected a CrewError');
}

const interventions = (c: TestContext, taskId: string) =>
  all<{ title: string; level: string }>(c.store.db, 'SELECT title, level FROM notifications WHERE task_id = ?', taskId);

function setup(clock = new ManualClock()) {
  ctx = createTestContext({ clock });
  const c = ctx;
  const { projectId } = seedProject(c);
  const add = (title: string, extra: Partial<Parameters<typeof addTask>[1]> = {}) =>
    addTask(c, { projectId, title, actor: operator, ...extra }, { config });
  return { c, clock, projectId, add };
}

describe('leases', () => {
  test('a claim returns a one-time token, is exclusive, and heartbeats extend only the current lease', () => {
    const { c, clock, add } = setup();
    const task = add('one');
    const claim = claimTask(c, { taskId: task.id, holder: agent('a1'), config });
    expect(claim.generation).toBe(1);
    expect(claim.token).toStartWith('crew_');
    expect(JSON.stringify(showTask(c, task.id))).not.toContain(claim.token);
    expect(errorOf(() => claimTask(c, { taskId: task.id, holder: agent('a2'), config })).code).toBe('LEASE_CONFLICT');

    clock.advance(600);
    const beat = heartbeat(c, claim, { config });
    expect(Date.parse(beat.expiresAt)).toBe(clock.now().getTime() + 900_000);
    expect(errorOf(() => heartbeat(c, { ...claim, token: `${claim.token}x` }, { config })).code).toBe('NOT_AUTHORIZED');
  });

  test('AT-14: after expiry and re-claim, the old generation is fenced out with STALE_LEASE', () => {
    const { c, clock, add } = setup();
    const task = add('fenced');
    const old = claimTask(c, { taskId: task.id, holder: agent('old'), config });
    startTask(c, old);

    clock.advance(901);
    expect(errorOf(() => heartbeat(c, old, { config })).code).toBe('STALE_LEASE');
    expect(expireLeases(c).map((l) => l.taskId)).toEqual([task.id]);
    expect(listTasksNeedingReconciliation(c).map((r) => r.task.id)).toEqual([task.id]);
    expect(showTask(c, task.id).task.state).toBe('RUNNING');
    expect(errorOf(() => claimTask(c, { taskId: task.id, holder: agent('new'), config })).code).toBe('LEASE_CONFLICT');

    expect(reconcileExpiredLease(c, task.id, { processAlive: true, worktreeDirty: false }).outcome).toBe(
      'deferred_process_alive',
    );
    expect(reconcileExpiredLease(c, task.id, { processAlive: false, worktreeDirty: false }).outcome).toBe('released');

    const fresh = claimTask(c, { taskId: task.id, holder: agent('new'), config });
    expect(fresh.generation).toBe(2);
    expect(errorOf(() => heartbeat(c, old, { config })).code).toBe('STALE_LEASE');
    expect(errorOf(() => submitWork(c, { ...old, handoff: { summary: 'late' } })).code).toBe('STALE_LEASE');
    expect(getNextAction(c, { agentId: 'old', lease: old, config })).toMatchObject({
      action: 'stop',
      reason: 'stale_lease',
    });
    expect(heartbeat(c, fresh, { config }).generation).toBe(2);
  });

  test('reconciliation preserves dirty work by blocking instead of releasing', () => {
    const { c, clock, add } = setup();
    const task = add('dirty');
    claimTask(c, { taskId: task.id, holder: agent('a'), config });
    clock.advance(1000);
    expireLeases(c);
    const result = reconcileExpiredLease(c, task.id, { processAlive: false, worktreeDirty: true });
    expect(result.outcome).toBe('preserved');
    expect(showTask(c, task.id).task).toMatchObject({ state: 'BLOCKED' });
    expect(interventions(c, task.id)).toEqual([{ title: `Task ${task.id} blocked`, level: 'action_required' }]);
  });

  test('exclusive reservations conflict transactionally and are held until merge', () => {
    const { c, add } = setup();
    const first = add('migration one', { exclusiveResources: ['lock:search-index'] });
    const second = add('migration two', { exclusiveResources: ['lock:search-index'] });
    const claim = claimTask(c, { taskId: first.id, holder: agent('a'), config });
    const error = errorOf(() => claimTask(c, { taskId: second.id, holder: agent('b'), config }));
    expect(error.code).toBe('RESERVATION_CONFLICT');
    expect(error.details?.conflictingTaskIds).toEqual([first.id]);

    submitWork(c, { ...claim, handoff: { summary: 'ready' } });
    expect(showTask(c, first.id).reservations.map((r) => r.scope)).toEqual(['lock:search-index']);
    for (const to of ['QUEUED', 'VALIDATING', 'MERGED'] as const)
      transitionTask(c, { taskId: first.id, to, actor: operator });
    expect(claimTask(c, { taskId: second.id, holder: agent('b'), config }).reservations[0]?.mode).toBe('exclusive');
  });

  test('approval-gated, paused and dependency-blocked tasks cannot be claimed', () => {
    const { c, add } = setup();
    const risky = add('auth change', { scopeHints: ['src/auth/**'] });
    expect(risky.requiresApproval).toBe(true);
    expect(errorOf(() => claimTask(c, { taskId: risky.id, holder: agent('a'), config })).code).toBe(
      'APPROVAL_REQUIRED',
    );
    expect(errorOf(() => decideTaskApproval(c, risky.id, 'approved', agent('a'))).code).toBe('NOT_AUTHORIZED');
    decideTaskApproval(c, risky.id, 'approved', operator);
    expect(claimTask(c, { taskId: risky.id, holder: agent('a'), config }).generation).toBe(1);

    const paused = add('paused');
    setTaskPaused(c, paused.id, true, operator);
    expect(errorOf(() => claimTask(c, { taskId: paused.id, holder: agent('b'), config })).details?.reason).toBe(
      'task_paused',
    );

    const child = add('child', { dependencies: [paused.id] });
    expect(errorOf(() => claimTask(c, { taskId: child.id, holder: agent('b'), config })).details?.reason).toBe(
      'dependencies_unsatisfied',
    );
  });

  test('handoff maps to transitions and DONE requires a merge for code tasks', () => {
    const { c, add } = setup();
    const code = add('code');
    const claim = claimTask(c, { taskId: code.id, holder: agent('a'), config });
    const result = completeTask(c, {
      ...claim,
      handoff: { summary: 'all done', commits: ['abc1234'], worktreePath: '/w' },
    });
    expect(result.transitions.map((t) => t.to)).toEqual(['SUBMITTED']);
    expect(showTask(c, code.id).task.artifacts.commits).toEqual(['abc1234']);
    expect(showTask(c, code.id).lease).toBeNull();
    expect(errorOf(() => transitionTask(c, { taskId: code.id, to: 'DONE', actor: operator })).code).toBe(
      'INVALID_TRANSITION',
    );

    const research = add('research', { repositoryId: null });
    const rc = claimTask(c, { taskId: research.id, holder: agent('b'), config });
    expect(completeTask(c, { ...rc, handoff: { summary: 'notes' } }).transitions.map((t) => t.to)).toEqual([
      'SUBMITTED',
      'DONE',
    ]);

    const blocked = add('blocked', { scopeHints: ['src/ui/**'] });
    const bc = claimTask(c, { taskId: blocked.id, holder: agent('c'), config });
    reportBlocker(c, { ...bc, handoff: { summary: 'need API key', remainingIssues: ['missing secret'] } });
    const detail = showTask(c, blocked.id);
    expect(detail.task.state).toBe('BLOCKED');
    expect(detail.task.blockerReason).toContain('need API key');
    expect(detail.reservations).toEqual([]);
    expect(interventions(c, blocked.id)).toEqual([{ title: `Task ${blocked.id} blocked`, level: 'action_required' }]);
  });

  test('voluntary release returns the task; force release is operator-only and audited', () => {
    const { c, add } = setup();
    const task = add('t');
    const claim = claimTask(c, { taskId: task.id, holder: agent('a'), config });
    expect(releaseLease(c, claim).to).toBe('READY');
    const again = claimTask(c, { taskId: task.id, holder: agent('a'), config });
    expect(again.generation).toBe(2);
    expect(errorOf(() => forceReleaseLease(c, task.id, { reason: 'stuck', actor: agent('a') })).code).toBe(
      'NOT_AUTHORIZED',
    );
    expect(
      errorOf(() => transitionTask(c, { taskId: task.id, to: 'READY', actor: { kind: 'github', id: 'pr' } })).code,
    ).toBe('POLICY_DENIED');
    const forced = forceReleaseLease(c, task.id, { reason: 'stuck', actor: operator, to: 'BLOCKED' });
    expect(forced.to).toBe('BLOCKED');
    const audit = c.store.db.query(`SELECT decision FROM audit_events WHERE action = 'lease.force_release'`).all();
    expect(audit).toEqual([{ decision: 'forced' }]);
  });

  test('next action guides an agent from claim to continue', () => {
    const { c, add } = setup();
    const low = add('low', { priority: 10 });
    const high = add('high', { priority: 90 });
    expect(getNextAction(c, { agentId: 'a', config })).toMatchObject({ action: 'claim', taskId: high.id });
    const claim = claimTask(c, { taskId: high.id, holder: agent('a'), config });
    expect(getNextAction(c, { agentId: 'a', config })).toMatchObject({ action: 'resume', taskId: high.id });
    expect(getNextAction(c, { agentId: 'a', lease: claim, config })).toMatchObject({ action: 'start' });
    startTask(c, claim);
    expect(getNextAction(c, { agentId: 'a', lease: claim, config })).toMatchObject({ action: 'continue' });
    expect(getNextAction(c, { agentId: 'b', config })).toMatchObject({ action: 'claim', taskId: low.id });
  });
});
