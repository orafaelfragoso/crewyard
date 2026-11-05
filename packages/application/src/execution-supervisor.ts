import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import {
  CrewError,
  ensureDir,
  isProcessAlive,
  killTree,
  matchesRecordedProcess,
  nowIso,
  processIdentity,
  toCrewError,
} from '@crewyard/core';
import { requestInterventionInTx } from '@crewyard/reviews';
import {
  abandonExecutionClaim,
  assertExecutionClaim,
  type ClaimedOutboxOperation,
  type CrewContext,
  claimDueOutbox,
  completeOutbox,
  getExecutionClaim,
  getOutbox,
  releaseExecutionClaim,
} from '@crewyard/storage';
import {
  EXECUTION_LAUNCH_KIND,
  type ExecutionLaunch,
  type ExecutionLimits,
  executionProcessState,
} from './execution.ts';
import { finishExecutionProcesses, stopExecutionProcesses } from './execution-processes.ts';
import { crewInvocation } from './service-control.ts';

interface RunningExecution {
  op: ClaimedOutboxOperation;
  launch: ExecutionLaunch;
  process: Bun.Subprocess;
  done: Promise<void>;
  startIdentity: string;
  deadlineSignaledAt: number | null;
}

export class ExecutionSupervisor {
  private readonly running = new Map<string, RunningExecution>();
  private stopping = false;

  constructor(
    private readonly ctx: CrewContext,
    private readonly ownerId: string,
    readonly limits: ExecutionLimits,
  ) {}

  get size(): number {
    return this.running.size;
  }

  private async settleExited(op: ClaimedOutboxOperation, launch: ExecutionLaunch, exitCode: number): Promise<void> {
    const current = getOutbox(this.ctx.store.db, op.operationId);
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return;
    const domain = getExecutionClaim(this.ctx.store.db, launch.claim.scope);
    if (!domain || domain.attemptId !== launch.claim.attemptId || domain.releasedAt !== null) return;
    const children = await finishExecutionProcesses(launch.directory, 1_000);
    try {
      this.ctx.store.immediate((db) => {
        const at = nowIso(this.ctx.clock);
        completeOutbox(
          db,
          op,
          {
            status: children.unverifiable || children.pending ? 'ambiguous' : 'failed',
            error: `Worker exited ${exitCode} before completion${children.unverifiable ? '; unverifiable children remain, resources preserved' : ''}`,
          },
          at,
        );
        if (children.unverifiable) {
          requestInterventionInTx(
            db,
            {
              projectId: launch.projectId,
              title: `Execution ${launch.claim.attemptId} needs process verification`,
              reasons: ['Unverifiable child processes remain. Attempt resources are preserved.'],
              once: true,
            },
            launch.actor,
            at,
          );
          return;
        }
        if (children.pending) return;
        if (domain.expiresAt > at) releaseExecutionClaim(db, launch.claim, at);
        else abandonExecutionClaim(db, launch.claim, at);
      });
    } catch (error) {
      if (!(error instanceof CrewError && error.code === 'STALE_LEASE')) throw error;
    }
  }

  pump(operationId?: string): void {
    if (this.stopping) return;
    for (const worker of this.running.values()) {
      if (Date.now() < Date.parse(worker.launch.deadlineAt)) continue;
      if (matchesRecordedProcess(worker.process.pid, worker.startIdentity) !== true) continue;
      worker.deadlineSignaledAt ??= performance.now();
      const graceElapsed = performance.now() - worker.deadlineSignaledAt >= this.limits.shutdownGraceSeconds * 1000;
      stopExecutionProcesses(worker.launch.directory);
      killTree(worker.process.pid, graceElapsed ? 'SIGKILL' : 'SIGTERM');
    }
    const capacity = this.limits.global - this.running.size;
    if (capacity <= 0) return;
    const claimed = claimDueOutbox(this.ctx.store, {
      ownerId: this.ownerId,
      kinds: [EXECUTION_LAUNCH_KIND],
      limit: capacity,
      ttlSeconds: this.limits.leaseSeconds,
      ...(operationId ? { operationIds: [operationId] } : {}),
    });
    for (const op of claimed) {
      const launch = op.intent as unknown as ExecutionLaunch;
      const domain = getExecutionClaim(this.ctx.store.db, launch.claim.scope);
      const at = nowIso(this.ctx.clock);
      if (!domain || domain.attemptId !== launch.claim.attemptId || domain.releasedAt !== null) {
        this.ctx.store.immediate((db) =>
          completeOutbox(
            db,
            op,
            { status: 'cancelled', error: 'Execution attempt superseded' },
            nowIso(this.ctx.clock),
          ),
        );
        continue;
      }
      if (domain.process) {
        const state = executionProcessState(domain);
        if (state !== 'dead') {
          if (state === 'live' && domain.expiresAt <= at) {
            stopExecutionProcesses(launch.directory);
            if (matchesRecordedProcess(domain.process.pid, domain.process.startIdentity) === true)
              killTree(domain.process.pid, 'SIGKILL');
          }
          this.ctx.store.immediate((db) =>
            completeOutbox(
              db,
              op,
              {
                status: 'ambiguous',
                error: `Prior execution process is ${state}; await verified exit`,
                nextAttemptAt: new Date(Date.parse(at) + 5_000).toISOString().replace('.000Z', 'Z'),
              },
              nowIso(this.ctx.clock),
            ),
          );
          continue;
        }
      }
      if (domain.expiresAt <= at || domain.process) {
        const children = stopExecutionProcesses(launch.directory);
        if (children.unverifiable || children.pending) {
          this.ctx.store.immediate((db) => {
            const now = nowIso(this.ctx.clock);
            completeOutbox(
              db,
              op,
              { status: 'ambiguous', error: 'Unverifiable children remain; resources preserved' },
              now,
            );
            if (children.unverifiable)
              requestInterventionInTx(
                db,
                {
                  projectId: launch.projectId,
                  title: `Execution ${launch.claim.attemptId} needs process verification`,
                  reasons: ['Unverifiable child processes remain. Attempt resources are preserved.'],
                  once: true,
                },
                launch.actor,
                now,
              );
          });
          continue;
        }
        this.ctx.store.immediate((db) => {
          completeOutbox(
            db,
            op,
            { status: 'failed', error: 'Prior execution ended without completion' },
            nowIso(this.ctx.clock),
          );
          if (domain.expiresAt <= nowIso(this.ctx.clock)) abandonExecutionClaim(db, domain, nowIso(this.ctx.clock));
          else releaseExecutionClaim(db, domain, nowIso(this.ctx.clock));
        });
        continue;
      }
      this.ctx.store.immediate((db) => assertExecutionClaim(db, launch.claim, nowIso(this.ctx.clock)));
      ensureDir(launch.directory);
      const log = openSync(join(launch.directory, 'worker.log'), 'a', 0o600);
      let child: Bun.Subprocess;
      try {
        child = Bun.spawn([...crewInvocation(), '__worker', op.operationId, op.claim.attemptId], {
          stdin: 'ignore',
          stdout: log,
          stderr: log,
          detached: process.platform !== 'win32',
          env: { ...process.env, CREW_DATA_DIR: this.ctx.dirs.data, CREW_CONFIG_DIR: this.ctx.dirs.config },
        });
      } catch (error) {
        closeSync(log);
        void this.settleExited(op, launch, -1).catch((failure: unknown) =>
          this.ctx.logger.error('execution launch reconciliation failed', { error: toCrewError(failure).message }),
        );
        throw error;
      }
      closeSync(log);
      const startIdentity = processIdentity(child.pid);
      if (!startIdentity) {
        child.kill('SIGKILL');
        throw new CrewError('UNAVAILABLE', 'Cannot verify launched execution process identity');
      }
      const done = child.exited
        .then((code) => this.settleExited(op, launch, code))
        .catch((error: unknown) => {
          this.ctx.logger.error('execution exit reconciliation failed', {
            operationId: op.operationId,
            error: toCrewError(error).message,
          });
        })
        .finally(() => this.running.delete(op.operationId));
      this.running.set(op.operationId, { op, launch, process: child, done, startIdentity, deadlineSignaledAt: null });
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const workers = [...this.running.values()];
    for (const worker of workers) {
      const claim = getExecutionClaim(this.ctx.store.db, worker.launch.claim.scope);
      if (
        claim?.attemptId === worker.launch.claim.attemptId &&
        claim.process &&
        matchesRecordedProcess(claim.process.pid, claim.process.startIdentity) === true
      ) {
        killTree(claim.process.pid, 'SIGTERM');
      } else if (!claim?.process && isProcessAlive(worker.process.pid)) {
        worker.process.kill('SIGTERM');
      }
    }
    const deadline = Date.now() + this.limits.shutdownGraceSeconds * 1000;
    while (this.running.size > 0 && Date.now() < deadline) await Bun.sleep(25);
    for (const worker of workers) {
      if (!this.running.has(worker.op.operationId)) continue;
      stopExecutionProcesses(worker.launch.directory);
      const claim = getExecutionClaim(this.ctx.store.db, worker.launch.claim.scope);
      if (
        claim?.attemptId === worker.launch.claim.attemptId &&
        claim.process &&
        matchesRecordedProcess(claim.process.pid, claim.process.startIdentity) === true
      )
        killTree(claim.process.pid, 'SIGKILL');
    }
    await Promise.race([Promise.all(workers.map((worker) => worker.done)), Bun.sleep(1_000)]);
  }
}
