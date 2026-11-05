import { closeSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  CrewError,
  ensureDir,
  fingerprint,
  isProcessAlive,
  killTree,
  matchesRecordedProcess,
  nowIso,
  processIdentity,
  toCrewError,
  withProcessLifecycle,
} from '@crewyard/core';
import { requestInterventionInTx } from '@crewyard/reviews';
import {
  abandonExecutionClaim,
  assertExecutionClaim,
  assertOutboxClaim,
  bindExecutionProcess,
  type ClaimedOutboxOperation,
  type CrewContext,
  claimDueOutbox,
  completeOutbox,
  enqueueOutbox,
  getExecutionClaim,
  getOutbox,
  recordTransition,
  releaseExecutionClaim,
  renewOutboxClaim,
} from '@crewyard/storage';
import {
  EXECUTION_CANCEL_KIND,
  EXECUTION_LAUNCH_KIND,
  type ExecutionLaunch,
  type ExecutionLimits,
  executionProcessState,
} from './execution.ts';
import { recoverExecutionDispatch } from './execution-dispatch.ts';
import { finishExecutionProcesses, recordExecutionProcess, stopExecutionProcesses } from './execution-processes.ts';
import { finishExecutionResources } from './execution-worktrees.ts';
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
  private recovering: Promise<void> | null = null;
  private nextRecovery = 0;
  private readonly reconciling = new Set<Promise<void>>();

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
    const identity = processIdentity(process.pid);
    if (!identity) throw new CrewError('UNAVAILABLE', 'Cannot verify execution recovery owner');
    const owned = this.ctx.store.immediate((db) => {
      const at = nowIso(this.ctx.clock);
      const delivery = assertOutboxClaim(db, op, at);
      if (
        delivery.process &&
        (delivery.process.host !== hostname() ||
          delivery.process.pid !== process.pid ||
          delivery.process.startIdentity !== identity)
      )
        return false;
      bindExecutionProcess(db, op.claim, { host: hostname(), pid: process.pid, startIdentity: identity }, at);
      return true;
    });
    if (!owned) return;
    // Recovery includes awaited Git preservation; its delivery outlives the worker lease.
    const ttlSeconds = Math.max(3, launch.limits.leaseSeconds);
    renewOutboxClaim(this.ctx.store, op, ttlSeconds);
    const controller = new AbortController();
    const recovery: CrewContext = {
      ...this.ctx,
      store: {
        ...this.ctx.store,
        immediate: (fn) =>
          this.ctx.store.immediate((db) => {
            assertOutboxClaim(db, op, nowIso(this.ctx.clock));
            return fn(db);
          }),
        preview: (fn) =>
          this.ctx.store.preview((db) => {
            assertOutboxClaim(db, op, nowIso(this.ctx.clock));
            return fn(db);
          }),
      },
    };
    const heartbeat = setInterval(
      () => {
        try {
          renewOutboxClaim(this.ctx.store, op, ttlSeconds);
        } catch (error) {
          controller.abort(error);
          this.ctx.logger.error('execution recovery renewal failed', {
            operationId: op.operationId,
            error: toCrewError(error).message,
          });
        }
      },
      Math.min(1_000, Math.floor((ttlSeconds * 1000) / 3)),
    );
    try {
      await withProcessLifecycle(
        {
          signal: controller.signal,
          onSpawn: (pid) => {
            recordExecutionProcess(launch.directory, pid);
            recovery.store.immediate(() => {});
          },
        },
        async () => {
          const children = await finishExecutionResources(recovery, launch);
          const cancellation = this.ctx.store.db
            .query(
              "SELECT json_extract(intent, '$.reason') AS reason FROM outbox WHERE kind = 'execution.cancel' AND subject_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(op.operationId) as { reason: string } | null;
          const reason = cancellation?.reason ?? `Execution worker exited ${exitCode} before completion`;
          let result: Record<string, unknown> | null = null;
          if (!children.unverifiable && !children.pending && !children.cleanupError) {
            try {
              result = await recoverExecutionDispatch(
                recovery,
                { ...op, remoteCorrelation: current.remoteCorrelation },
                launch,
                reason,
              );
            } catch (error) {
              if (error instanceof CrewError && error.code === 'STALE_LEASE') throw error;
              children.cleanupError = toCrewError(error).message;
            }
          }
          const remaining = await finishExecutionProcesses(launch.directory, 1_000);
          children.unverifiable += remaining.unverifiable;
          children.pending += remaining.pending;
          try {
            recovery.store.immediate((db) => {
              const at = nowIso(this.ctx.clock);
              completeOutbox(
                db,
                op,
                {
                  status:
                    children.unverifiable || children.pending || children.cleanupError
                      ? 'ambiguous'
                      : cancellation
                        ? 'cancelled'
                        : 'failed',
                  error: children.cleanupError ?? reason,
                  ...(result ? { remoteCorrelation: { result } } : {}),
                },
                at,
              );
              if (children.unverifiable || children.cleanupError) {
                requestInterventionInTx(
                  db,
                  {
                    projectId: launch.projectId,
                    title: `Execution ${launch.claim.attemptId} needs process verification`,
                    reasons: [
                      children.cleanupError ?? 'Unverifiable child processes remain. Attempt resources are preserved.',
                    ],
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
        },
      );
    } finally {
      clearInterval(heartbeat);
      controller.abort();
      await finishExecutionProcesses(launch.directory, 1_000);
      this.ctx.store.immediate((db) => {
        const delivery = getExecutionClaim(db, op.claim.scope);
        if (delivery?.attemptId !== op.claim.attemptId || delivery.releasedAt !== null) return;
        const at = nowIso(this.ctx.clock);
        if (delivery.expiresAt > at) releaseExecutionClaim(db, op.claim, at);
        else abandonExecutionClaim(db, op.claim, at);
      });
      this.processCancellations();
    }
  }

  private recoverDelivery(operationId: string, launch: ExecutionLaunch): ClaimedOutboxOperation | null {
    const observed = getExecutionClaim(this.ctx.store.db, launch.claim.scope);
    if (!observed || observed.attemptId !== launch.claim.attemptId || observed.releasedAt !== null) return null;
    if (
      executionProcessState(observed) !== 'dead' ||
      (!observed.process && observed.expiresAt > nowIso(this.ctx.clock))
    )
      return null;
    const observedDelivery = getExecutionClaim(this.ctx.store.db, `outbox:${operationId}`);
    if (
      observedDelivery?.releasedAt === null &&
      observedDelivery.process &&
      executionProcessState(observedDelivery) !== 'dead'
    )
      return null;
    const identity = processIdentity(process.pid);
    if (!identity) throw new CrewError('UNAVAILABLE', 'Cannot verify execution recovery process identity');
    const recovered = this.ctx.store.immediate((db) => {
      const current = getExecutionClaim(db, observed.scope);
      const operation = getOutbox(db, operationId);
      const at = nowIso(this.ctx.clock);
      if (
        current?.attemptId !== observed.attemptId ||
        current.releasedAt !== null ||
        !operation ||
        ['succeeded', 'failed', 'cancelled'].includes(operation.status)
      )
        return false;
      const delivery = getExecutionClaim(db, `outbox:${operationId}`);
      if (
        delivery?.attemptId !== observedDelivery?.attemptId ||
        fingerprint(delivery?.process ?? null) !== fingerprint(observedDelivery?.process ?? null)
      )
        return false;
      if (delivery?.releasedAt === null) {
        if (delivery.expiresAt > at) {
          assertOutboxClaim(db, { ...operation, claim: delivery }, at);
          releaseExecutionClaim(db, delivery, at);
        } else abandonExecutionClaim(db, delivery, at);
      }
      db.query('UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE operation_id = ?').run(at, at, operationId);
      recordTransition(
        db,
        {
          type: 'execution.delivery_recovered',
          actor: launch.actor,
          projectId: launch.projectId,
          payload: { operationId, attemptId: observed.attemptId },
        },
        { action: 'execution.recover_delivery', input: { operationId }, decision: 'verified_worker_exit' },
        at,
      );
      return true;
    });
    if (!recovered) return null;
    return (
      claimDueOutbox(this.ctx.store, {
        ownerId: this.ownerId,
        kinds: [EXECUTION_LAUNCH_KIND],
        limit: 1,
        ttlSeconds: Math.max(3, launch.limits.leaseSeconds),
        preserveProcessClaims: true,
        operationIds: [operationId],
        process: { host: hostname(), pid: process.pid, startIdentity: identity },
      })[0] ?? null
    );
  }

  recover(): Promise<void> {
    if (this.recovering) return this.recovering;
    const pending = this.recoverExpired().finally(() => {
      this.recovering = null;
    });
    this.recovering = pending;
    return pending;
  }

  private async recoverExpired(): Promise<void> {
    this.processCancellations();
    const operations = this.ctx.store.db
      .query(
        "SELECT o.operation_id FROM outbox o JOIN execution_claims c ON c.attempt_id = json_extract(o.intent, '$.claim.attemptId') WHERE o.kind = 'execution.launch' AND o.status IN ('pending','attempted','ambiguous') AND c.released_at IS NULL ORDER BY o.created_at LIMIT 100",
      )
      .all() as { operation_id: string }[];
    for (const row of operations) {
      if (this.running.has(row.operation_id)) continue;
      const operation = getOutbox(this.ctx.store.db, row.operation_id)!;
      const launch = operation.intent as unknown as ExecutionLaunch;
      const claim = getExecutionClaim(this.ctx.store.db, launch.claim.scope);
      const at = nowIso(this.ctx.clock);
      if (
        claim?.attemptId === launch.claim.attemptId &&
        claim.releasedAt === null &&
        executionProcessState(claim) === 'live' &&
        (claim.expiresAt <= at || launch.deadlineAt <= at)
      ) {
        this.ctx.store.immediate((db) => {
          const current = getExecutionClaim(db, claim.scope);
          if (
            current?.attemptId !== claim.attemptId ||
            current.releasedAt !== null ||
            (current.expiresAt > at && launch.deadlineAt > at)
          )
            return;
          enqueueOutbox(
            db,
            {
              kind: EXECUTION_CANCEL_KIND,
              projectId: launch.projectId,
              taskId: operation.taskId,
              subjectId: operation.operationId,
              intent: { operationId: operation.operationId, reason: 'Execution ownership or deadline expired' },
              idempotencyKey: `execution-cancel:${operation.operationId}`,
            },
            at,
          );
        });
        this.processCancellations();
      }
      const delivery = this.recoverDelivery(operation.operationId, launch);
      if (delivery) await this.settleExited(delivery, launch, -1);
    }
  }

  private processCancellations(): void {
    this.ctx.store.immediate((db) => {
      const at = nowIso(this.ctx.clock);
      const ready = db
        .query(`
        SELECT c.operation_id FROM outbox c JOIN outbox target ON target.operation_id = c.subject_id
        WHERE c.kind = 'execution.cancel' AND c.status IN ('pending','attempted','ambiguous')
          AND c.next_attempt_at > ? AND target.status IN ('succeeded','failed','cancelled')
      `)
        .all(at) as { operation_id: string }[];
      for (const row of ready) {
        db.query('UPDATE outbox SET next_attempt_at = ?, updated_at = ? WHERE operation_id = ?').run(
          at,
          at,
          row.operation_id,
        );
        recordTransition(
          db,
          {
            type: 'execution.cancellation_ready',
            actor: { kind: 'system', id: this.ownerId },
            payload: { operationId: row.operation_id },
          },
          {
            action: 'execution.reconcile_cancellation',
            input: { operationId: row.operation_id },
            decision: 'target_terminal',
          },
          at,
        );
      }
    });
    const cancellations = claimDueOutbox(this.ctx.store, {
      ownerId: this.ownerId,
      kinds: [EXECUTION_CANCEL_KIND],
      limit: 16,
      ttlSeconds: this.limits.leaseSeconds,
    });
    for (const cancellation of cancellations) {
      const operationId = cancellation.intent.operationId as string;
      const target = getOutbox(this.ctx.store.db, operationId);
      const launch = target?.intent as unknown as ExecutionLaunch | undefined;
      const claim = launch ? getExecutionClaim(this.ctx.store.db, launch.claim.scope) : null;
      let status: 'succeeded' | 'ambiguous' = 'succeeded';
      let error: string | undefined;
      if (
        target &&
        !['succeeded', 'failed', 'cancelled'].includes(target.status) &&
        claim !== null &&
        claim.attemptId === launch?.claim.attemptId &&
        claim.releasedAt === null
      ) {
        const state = executionProcessState(claim);
        if (claim.process && state === 'live') {
          const elapsed = Date.now() - Date.parse(cancellation.createdAt);
          const force = elapsed >= launch!.limits.shutdownGraceSeconds * 1000;
          if (force) stopExecutionProcesses(launch!.directory);
          killTree(claim.process.pid, force ? 'SIGKILL' : 'SIGTERM');
          status = 'ambiguous';
          error = 'Cancellation requested; awaiting verified execution exit';
        } else if (state === 'unknown') {
          status = 'ambiguous';
          error = 'Cannot verify execution process identity for cancellation';
          this.ctx.store.immediate((db) =>
            requestInterventionInTx(
              db,
              {
                projectId: launch!.projectId,
                title: `Execution ${claim.attemptId} needs process verification`,
                reasons: [error!],
                once: true,
              },
              launch!.actor,
              nowIso(this.ctx.clock),
            ),
          );
        } else {
          if (claim.process) {
            const recovered = this.recoverDelivery(operationId, launch!);
            if (recovered) {
              const pending = this.settleExited(recovered, launch!, -1)
                .catch((failure: unknown) =>
                  this.ctx.logger.error('cancelled execution reconciliation failed', {
                    error: toCrewError(failure).message,
                  }),
                )
                .finally(() => this.reconciling.delete(pending));
              this.reconciling.add(pending);
            }
          }
          const [delivery] = claim.process
            ? []
            : claimDueOutbox(this.ctx.store, {
                ownerId: this.ownerId,
                kinds: [EXECUTION_LAUNCH_KIND],
                limit: 1,
                ttlSeconds: this.limits.leaseSeconds,
                operationIds: [operationId],
                preserveProcessClaims: true,
              });
          if (!delivery || claim.process) {
            status = 'ambiguous';
            error = 'Execution is starting or awaiting exit reconciliation';
          } else
            this.ctx.store.immediate((db) => {
              const at = nowIso(this.ctx.clock);
              completeOutbox(db, delivery, { status: 'cancelled', error: cancellation.intent.reason as string }, at);
              if (claim.expiresAt > at) releaseExecutionClaim(db, claim, at);
              else abandonExecutionClaim(db, claim, at);
            });
        }
      }
      this.ctx.store.immediate((db) =>
        completeOutbox(
          db,
          cancellation,
          status === 'succeeded'
            ? { status }
            : { status, error: error!, nextAttemptAt: new Date(Date.now() + 1_000).toISOString() },
          nowIso(this.ctx.clock),
        ),
      );
    }
  }

  pump(operationId?: string): void {
    if (this.stopping) return;
    this.processCancellations();
    if (performance.now() >= this.nextRecovery) {
      this.nextRecovery = performance.now() + 1_000;
      void this.recover().catch((error: unknown) =>
        this.ctx.logger.error('execution recovery failed', {
          error: toCrewError(error).message,
        }),
      );
    }
    for (const worker of this.running.values()) {
      if (Date.now() < Date.parse(worker.launch.deadlineAt)) continue;
      if (matchesRecordedProcess(worker.process.pid, worker.startIdentity) !== true) continue;
      worker.deadlineSignaledAt ??= performance.now();
      const graceElapsed =
        performance.now() - worker.deadlineSignaledAt >= worker.launch.limits.shutdownGraceSeconds * 1000;
      stopExecutionProcesses(worker.launch.directory);
      killTree(worker.process.pid, graceElapsed ? 'SIGKILL' : 'SIGTERM');
    }
    const capacity = this.limits.global - this.running.size;
    if (capacity <= 0) return;
    const claimed = claimDueOutbox(this.ctx.store, {
      ownerId: this.ownerId,
      kinds: [EXECUTION_LAUNCH_KIND],
      limit: capacity,
      preserveProcessClaims: true,
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
        const recovery = this.settleExited(op, launch, -1)
          .catch((error: unknown) =>
            this.ctx.logger.error('execution recovery failed', {
              operationId: op.operationId,
              error: toCrewError(error).message,
            }),
          )
          .finally(() => this.reconciling.delete(recovery));
        this.reconciling.add(recovery);
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
    const stoppingAt = performance.now();
    while (this.running.size > 0) {
      let waiting = false;
      for (const worker of workers) {
        if (!this.running.has(worker.op.operationId)) continue;
        if (performance.now() - stoppingAt < worker.launch.limits.shutdownGraceSeconds * 1000) {
          waiting = true;
          continue;
        }
        stopExecutionProcesses(worker.launch.directory);
        if (matchesRecordedProcess(worker.process.pid, worker.startIdentity) === true)
          killTree(worker.process.pid, 'SIGKILL');
      }
      if (!waiting) break;
      await Bun.sleep(25);
    }
    await Promise.race([
      Promise.all([...workers.map((worker) => worker.done), ...this.reconciling, this.recovering]),
      Bun.sleep(1_000),
    ]);
  }
}
