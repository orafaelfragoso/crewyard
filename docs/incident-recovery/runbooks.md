# Incident and recovery runbooks

Rail is designed to converge on its own after a restart: the service reconciles processes, leases, the outbox and GitHub state before resuming work. These runbooks are for when you need to see what happened or step in.

Start every investigation with:

```bash
rail doctor --json
rail service status --json
rail events list --project <name> --json        # recent events with correlation IDs
rail task show <task-id> --json                 # state, lease generation, attempts, blocker
```

Never delete rows from the database, edit worktrees under the data directory by hand, or force-push task branches to "fix" state. Use the commands below; they are audited and fenced.

## Agent crash

**Symptoms:** a session shows `failed` or disappears; its task stays `CLAIMED`/`RUNNING` until the lease expires.

1. `rail agent logs <session-id>` for the last output and exit reason.
2. The worktree and commits are preserved. `rail workspace inspect <workspace-id>` shows the branch, head SHA and uncommitted changes.
3. When the lease expires, the service first checks whether the process is gone and the worktree is intact. Only then does it make the task claimable again; the new owner resumes in the same worktree, and the commits stay attributed to the task.
4. To act now: `rail task release <task-id>` (operator), or `rail task retry <task-id>` to reschedule.

## Lease expiry while the old process is still running

**Symptoms:** `STALE_LEASE` errors from an agent; two sessions appear to work on one task.

- The old lease generation is fenced: its heartbeats, progress reports and submissions are rejected, so it cannot overwrite the new owner.
- The service reconciles the old process before reassigning the task. Managed sessions are cancelled (SIGTERM, then SIGKILL after `agents.cancel_grace_seconds`). Unmanaged agents are only reported, because Rail cannot stop them.
- If expiry happens often, the lease is too short for the work or heartbeats are not being sent. Raise `agents.default_task_lease_seconds`, or check that the agent follows the `rail-execution` skill.

## CI failure loop

**Symptoms:** the same check keeps failing; the task bounces between `REVISION` and `QUEUED`.

1. `rail queue explain --pr <n> --json` shows the failure fingerprint and attempt count.
2. Rail tells transient failures (runner, network, rate limit) apart from deterministic ones. Transient failures are retried with backoff. Deterministic failures get a bounded recovery task (`agents.max_retries_per_failure`, default 2).
3. At the limit the PR moves to `ESCALATED` and is quarantined. Unrelated PRs keep integrating.
4. Fix it yourself, or `rail task retry <task-id>` after changing something; an identical retry on an identical failure is refused.
5. A positive AI review never waives a failing required check.

## Ambiguous merge (timeout after a merge request)

**Symptoms:** `AMBIGUOUS_REMOTE_OUTCOME`; the queue entry is waiting for reconciliation.

1. Do not retry the merge by hand.
2. The outbox operation keeps its idempotency key. Before any retry, Rail re-reads the PR, the base branch and the merge queue to learn the actual outcome.
3. If GitHub shows the PR merged, Rail records the observed merge commit and moves on. If it is not merged and the base and head SHAs are unchanged, the merge is retried once under the leader lease. If either changed, the candidate is invalidated and rebuilt.
4. Check progress with `rail sync` and then `rail queue status --json`.

## Offline

**Symptoms:** `OFFLINE` errors; the dashboard shows "last seen" timestamps.

- Local work continues: reads, search, planning, coding in worktrees and queued intents.
- Remote mutations wait in the outbox. Rail never reports a PR, check or merge as done while offline.
- When the connection returns, Rail reconciles remote state before replaying pending mutations. Run `rail sync` to trigger it now.
- To stay offline on purpose: `security.network: offline` (or `RAIL_NETWORK=offline`).

## Database busy or corrupted

**Busy** (`BUSY` errors, slow commands):

1. Rail retries transient contention with a bounded busy timeout. Persistent `BUSY` usually means a process is holding a long transaction or the filesystem has broken locking.
2. `rail doctor` checks `sqlite.locking` and `sqlite.wal`. Move the data directory off network or synced filesystems (`RAIL_DATA_DIR`).
3. Look for hung `rail` processes: `rail service status`, `ps`/Task Manager. Stopping them releases their locks.

**Corrupted** (`SQLITE_CORRUPT`, `database disk image is malformed`, failed integrity check):

1. Stop every Rail process: the service, `rail mcp` instances (close the agent hosts) and the dashboard.
2. Keep the evidence: copy `agent-rail.sqlite`, `-wal` and `-shm` to a safe place.
3. Check integrity read-only: `sqlite3 agent-rail.sqlite 'PRAGMA integrity_check;'`.
4. Restore the newest good backup from `backups/` ([steps](../installation.md#back-up-and-restore)), then run `rail doctor`.
5. On the next service start, Rail reconciles against reality: live processes, worktrees and GitHub. GitHub state is authoritative for PRs and merges.
6. State changes made after the backup are lost from the database, but worktrees, branches and PRs still exist. Re-import open PRs with `rail pr import` and check tasks with `rail task list`.
7. [Re-authorize providers](../installation.md#re-authorize-providers-after-a-restore-or-a-move) if the profiles reference credentials that are no longer present.

## Orphan sessions

**Symptoms:** agent processes running with no matching active session, for example after the service was killed.

- On startup the service inspects recorded process IDs and process trees. It terminates sessions whose task is no longer leased to them, and marks still-valid ones for reattachment where the provider supports it.
- Cleanup is idempotent; running it again does nothing.
- `rail agent stop <session-id>` cancels a specific session and its process tree.
- Agents started outside Rail (unmanaged) are never killed by Rail. Stop them in their host.

## Stale locks

**Symptoms:** a task cannot be claimed because of a scope reservation; the integration queue does not advance because a leader lease is held.

- Reservations and leadership are leases with expiry and generation, not file locks. Expired holders are fenced and their leases released on the next reconciliation tick.
- `rail queue status --json` shows the current integration leader and its expiry. `rail task show <task-id> --json` shows reservations.
- If a crashed process held them, wait for expiry, or run `rail service stop` then `rail service start`. Startup reconciles leases before resuming work.
- Stale `run/service.pid` files are ignored when the process is no longer alive.
