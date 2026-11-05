# Incident and recovery runbooks

Crewyard is designed to converge after a restart: the service schedules finite workers to reconcile processes,
leases, the outbox and GitHub state. Startup reporting distinguishes deferred reconciliation from completed
recovery; current claims and domain guards still control admission. These runbooks are for when you need to
see what happened or step in.

Start every investigation with:

```bash
crew doctor --json
crew service status --json
crew events list --project <name> --json        # recent events with correlation IDs
crew task show <task-id> --json                 # state, lease generation, attempts, blocker
```

Never delete rows from the database, edit worktrees under the data directory by hand, or force-push task branches to "fix" state. Use the commands below; they are audited and fenced.

## Agent crash

**Symptoms:** a session fails or disappears; its task may remain `CLAIMED`/`RUNNING` pending reconciliation.

1. `crew agent logs <session-id>` for the last output and exit reason.
2. The worktree and commits are preserved. `crew workspace inspect <workspace-id>` shows the branch, head SHA and uncommitted changes.
3. Inspect execution recovery events. For a managed dispatch, recovery verifies the exact worker/children and task lease, commits pending work and returns the still-owned task to `READY` (or `CANCELLED` for a cancellation request). A newer generation or a handed-off task is not reset.
4. Generic expired-lease recovery preserves dirty work as `BLOCKED`; live or unverifiable processes defer reassignment. Resolve that blocker before using `crew task retry <task-id> --reason "recovery verified"`. Do not force-release ownership while an old process may still write.

## Interrupted execution or service shutdown

`crew service stop` cancels that service's workers. It does not cancel workers owned by independent direct CLI/MCP
callers. A direct long operation uses the same durable execution path without needing the service, but closing its
host is not a promise of continued background execution.

1. Check `crew service status --json`, `crew agent sessions --json` and recent `crew events list --json` output. Match the task, execution attempt and recorded process identities before acting.
2. Workers get their recorded shutdown grace (default 10 seconds), followed by verified termination and child-process drain. A renewable recovery delivery owns Git preservation while it runs.
3. For dispatch interrupted during bootstrap, `lease.execution_bound` identifies the exact task lease even without provider progress. Recovery affects only that lease generation and its sessions.
4. Inspect `crew workspace inspect <workspace-id>` and task state. Task worktrees remain preserved. Disposable review/candidate worktrees can be removed only from an exact attempt manifest after verified process exit.
5. If ownership is unknown, preserve the attempt directory, logs and worktree and investigate the reported intervention. Do not kill a PID based on its number alone or delete an unregistered partial worktree. Retry only after ownership and preservation are resolved.

Attempt logs and manifests live under `<data>/artifacts/executions/<attempt-id>/`; see
[data layout](../installation.md#where-data-lives). Lease expiry alone never proves a worker or child exited.

## Lease expiry while the old process is still running

**Symptoms:** `STALE_LEASE` errors from an agent; two sessions appear to work on one task.

- The old lease generation is fenced: its heartbeats, progress reports and submissions are rejected. This does not stop an unsandboxed process from writing files, so ownership is not reassigned merely because a lease expired.
- The service reconciles the old process before reassigning the task. Managed sessions are cancelled (SIGTERM, then SIGKILL after `agents.cancel_grace_seconds`). Unmanaged agents are only reported, because Crewyard cannot stop them.
- If expiry happens often, the lease is too short for the work or heartbeats are not being sent. Raise `agents.default_task_lease_seconds`, or check that the agent follows the `crew-execution` skill.

## CI failure loop

**Symptoms:** the same check keeps failing; the task bounces between `REVISION` and `QUEUED`.

1. `crew queue explain --pr <n> --json` shows the failure fingerprint and attempt count.
2. Crewyard tells transient failures (runner, network, rate limit) apart from deterministic ones. Transient failures are retried with backoff. Deterministic failures get a bounded recovery task (`agents.max_retries_per_failure`, default 2).
3. At the limit the PR moves to `ESCALATED` and is quarantined. Unrelated PRs keep integrating.
4. Fix the failure, then use `crew task retry <task-id> --reason "failure corrected"`. If the task still has a lease, resolve its live processes and ownership first. Retrying a task does not waive integration failure policy.
5. A positive AI review never waives a failing required check.

## Ambiguous merge (timeout after a merge request)

**Symptoms:** `AMBIGUOUS_REMOTE_OUTCOME`; the queue entry is waiting for reconciliation.

1. Do not retry the merge by hand.
2. The outbox operation keeps its idempotency key. Before any retry, Crewyard re-reads the PR, the base branch and the merge queue to learn the actual outcome.
3. If GitHub shows the PR merged, Crewyard adopts the actual merge SHA. Otherwise, only a confirmed unapplied action may retry after all current mutation guards pass, including base/head/target, leadership, approvals, rules and unexpired prefix evidence. Changed inputs invalidate or block the action. An unresolved outcome remains blocked; a timeout does not prove nonexecution.
4. Check progress with `crew sync` and then `crew queue status --json`.

## Unexpected merge tree or failed post-merge checks

A tree mismatch is an incident detected after landing; subsequent local merges pause. Preserve the expected and observed tree, actual merge SHA and target branch. Inspect the current base before proposing a repair. Repeated commit-bound observations reuse one incident and repair task. A draft repair needs ordinary scope/risk review and approval; no automatic revert is authorized. Unknown, superseded or unavailable health is never passed. Failed task hooks remain durable outbox work with bounded retries; merged-task reconciliation repairs missing merge transitions.

## Offline

**Symptoms:** `OFFLINE` errors; the dashboard shows "last seen" timestamps.

- Local work continues: reads, search, planning, coding in worktrees and queued intents.
- Remote mutations wait in the outbox. Crewyard never reports a PR, check or merge as done while offline.
- When the connection returns, Crewyard reconciles remote state before replaying pending mutations. Run `crew sync` to trigger it now.
- To stay offline on purpose: `security.network: offline` (or `CREW_NETWORK=offline`).

## Database busy or corrupted

**Busy** (`BUSY` errors, slow commands):

1. Lock acquisition has a default total wait budget of 1,000 ms plus at most one 50 ms native poll, with bounded retries. Persistent contention returns `BUSY`; inspect operation counters `busyRetries`, `busyWaitMs` and `busyFailures` before changing capacity.
2. `crew doctor` checks `sqlite.locking` and `sqlite.wal`. Move the data directory off network or synced filesystems (`CREW_DATA_DIR`).
3. Look for hung `crew` processes: `crew service status`, `ps`/Task Manager. Stopping them releases their locks.

**Corrupted** (`SQLITE_CORRUPT`, `database disk image is malformed`, failed integrity check):

1. Stop every Crewyard process: service and direct workers, `crew mcp` instances (close the agent hosts), dashboards and provider children. Verify unfinished attempts are reconciled or retained for intervention.
2. Keep the evidence: copy `crewyard.sqlite`, `-wal` and `-shm` to a safe place.
3. Check integrity read-only: `sqlite3 crewyard.sqlite 'PRAGMA integrity_check;'`.
4. Restore a verified backup only as disaster recovery ([steps](../installation.md#back-up-and-restore)). Use the current corrected build, keep scheduling stopped, and account for acknowledged writes and remote effects after the backup before resuming.
5. On the next service start, Crewyard reconciles against reality: live processes, worktrees and GitHub. GitHub state is authoritative for PRs and merges.
6. State changes made after the backup are lost from the database, but worktrees, branches and PRs still exist. Re-import open PRs with `crew pr import` and check tasks with `crew task list`.
7. [Re-authorize providers](../installation.md#re-authorize-providers-after-a-restore-or-a-move) if the profiles reference credentials that are no longer present.

## Orphan sessions

**Symptoms:** agent processes running with no matching active session, for example after the service was killed.

- Reconciliation inspects recorded process identity and children. It can terminate a live orphan only when the recorded birth identity still matches; dead sessions become `lost`. Unverifiable processes are reported and preserved, never killed by PID alone. Provider resume support does not imply automatic reattachment to an old supervisor.
- Cleanup is idempotent; running it again does nothing.
- `crew agent stop <session-id>` cancels a specific session and its process tree.
- Agents started outside Crewyard (unmanaged) are never killed by Crewyard. Stop them in their host.

## Stale locks

**Symptoms:** a task cannot be claimed because of a scope reservation; the integration queue does not advance because a leader lease is held.

- Reservations and leadership use leases with expiry and generation, not file locks. Expired holders are fenced. Task reservations stay held until process/workspace reconciliation makes release safe; execution claims also require proof that recorded processes and resources can be reused.
- `crew queue status --json` shows the current integration leader and its expiry. `crew task show <task-id> --json` shows reservations.
- If a crashed process held them, inspect the next recovery tick or restart the service. Startup may report deferred recovery; it does not promise that every lease has been reconciled before unrelated work resumes.
- Stale `run/service.pid` files are ignored when the process is no longer alive.
