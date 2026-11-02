# CLI reference

> **Generated from the v1.0 specification (§14), not from the implementation.** Command and subcommand names are normative. Flags beyond those in the specification are provisional until this page is reconciled with `apps/cli`. `rail <command> --help` is authoritative for your build.

## Global conventions

- Root command: `rail`.
- `--json` on every read command prints one well-formed JSON object; streaming commands (`events follow`) print JSONL. Progress and diagnostics go to stderr, never mixed into JSON on stdout.
- Mutating commands accept `--project <name|id>` (default: the project of the current directory), `--dry-run` where meaningful, and require confirmation or authorization for destructive or policy-gated actions.
- Timestamps are RFC 3339 UTC. IDs are opaque and stable.
- Tokens and secrets are never printed.
- Precedence: flags > `RAIL_*` environment variables > repository config > user config > defaults.

### Errors and exit codes

Errors print a stable uppercase code, an actionable message, a `retryable` flag and, when known, a suggestion. With `--json`:

```json
{ "ok": false, "operationId": "op_01...", "error": { "code": "LEASE_CONFLICT", "message": "...", "retryable": true, "suggestion": "..." } }
```

| Exit | Meaning | Codes |
|---|---|---|
| 0 | Success | — |
| 2 | Invalid input | `INVALID_INPUT`, `NOT_FOUND`, `CYCLE_DETECTED`, `UNSUPPORTED_CAPABILITY`, `CONFIG_INVALID` |
| 3 | Conflict | `CONFLICT`, `LEASE_CONFLICT`, `STALE_LEASE`, `INVALID_TRANSITION`, `RESERVATION_CONFLICT`, `HEAD_MISMATCH` |
| 4 | Not authorized | `NOT_AUTHORIZED`, `UNAUTHENTICATED` |
| 5 | External failure | `EXTERNAL_FAILURE`, `RATE_LIMITED`, `AMBIGUOUS_REMOTE_OUTCOME` |
| 6 | Unavailable / offline | `OFFLINE`, `UNAVAILABLE`, `INDEX_STALE`, `BUSY` |
| 7 | Policy denied | `POLICY_DENIED`, `APPROVAL_REQUIRED` |
| 8 | Internal error | `INTERNAL`, `SCHEMA_TOO_NEW`, `MIGRATION_FAILED` |

Retryable by default: `LEASE_CONFLICT`, `EXTERNAL_FAILURE`, `RATE_LIMITED`, `OFFLINE`, `UNAVAILABLE`, `BUSY`, `INDEX_STALE`.

### Environment variables

| Variable | Effect |
|---|---|
| `RAIL_DATA_DIR`, `RAIL_CONFIG_DIR` | Override the data and user-config directories |
| `RAIL_AUTONOMY`, `RAIL_BASE_BRANCH` | `project.autonomy`, `project.base_branch` |
| `RAIL_MAX_PARALLEL`, `RAIL_LEASE_SECONDS`, `RAIL_HEARTBEAT_SECONDS` | `agents.*` limits |
| `RAIL_MAX_OPEN_PRS` | `scheduler.max_open_prs` |
| `RAIL_INTEGRATION_MODE`, `RAIL_AUTO_MERGE` | `integration.mode`, `integration.auto_merge_eligible` |
| `RAIL_NETWORK` | `security.network` |
| `RAIL_MAX_CONTEXT_TOKENS`, `RAIL_INDEX_LANGUAGES` | `index.max_context_tokens`, `index.languages` (comma-separated) |
| `RAIL_LOG_LEVEL` | `debug`, `info`, `warn`, `error` (stderr) |

## Commands

### Setup and diagnostics

| Command | Description |
|---|---|
| `rail init [--repo PATH]` | Verify the Git repository and remote, select the base branch, initialize local state, write `.agent-rail/config.yaml`, detect `gh`, offer host installation, start the initial index, print a readiness report |
| `rail doctor [--json]` | Environment and readiness checks with repairs; see [doctor.md](../doctor.md) |
| `rail config show [--json]` | Effective configuration with sources; credentials redacted |
| `rail config validate [FILE]` | Validate a config file: schema, unknown keys, secrets, contradictions |
| `rail config set PATH VALUE [--dry-run]` | Set a repository config value; refuses secret-like keys and invalid results |
| `rail install --target codex,claude,opencode [--scope user\|project] [--instructions] [--dry-run]` | Register `rail mcp` and install Skills in agent hosts, with backups; prints manual instructions when a file cannot be edited safely. See [mcp-hosts.md](../mcp-hosts.md) |
| `rail uninstall --target ... [--scope user\|project] [--dry-run]` | Remove only Rail-owned entries, Skills and instruction blocks; restore backups |
| `rail version [--json]` | Version, Bun runtime, platform and build information |

### Projects, accounts, agents

| Command | Description |
|---|---|
| `rail project add\|list\|show\|sync\|pause\|resume` | Manage projects; `pause`/`resume` stop or restart intake of new work |
| `rail account add\|list\|show\|test\|remove` | Provider account profiles (`--provider ID --name NAME`); secrets go to the OS secret store |
| `rail agent create\|list\|show\|run\|stop\|logs` | Agent definitions (`--name`, `--provider`, `--account`) and their managed sessions |
| `rail team create\|list\|assign` | Group agents and assign them to projects |

### Goals and tasks

| Command | Description |
|---|---|
| `rail goal create --title T [--description-file F]` | Create a goal |
| `rail goal plan GOAL --agent ID` | Ask a planning agent for a task DAG; Rail validates it |
| `rail goal approve GOAL` | Operator approval of a validated plan |
| `rail goal status\|cancel GOAL` | Progress or cancellation |
| `rail task add\|list\|show` | Create, query and inspect tasks |
| `rail task next --agent ID` | Next safe action for an agent (same as `rail_get_next_action`) |
| `rail task claim TASK --agent ID` | Acquire the lease and scope reservations (`rail_claim_task`) |
| `rail task heartbeat TASK` | Renew the current lease generation (`rail_heartbeat`) |
| `rail task release TASK` | Release a lease |
| `rail task start TASK` | Mark claimed work as running |
| `rail task report TASK` | Structured progress or checkpoint (`rail_report_progress`) |
| `rail task complete TASK` | Hand off with evidence (`rail_submit_work`) |
| `rail task block TASK --reason R` | Report a blocker (`rail_report_blocker`) |
| `rail task retry TASK` | Reschedule a blocked or failed task |

### Context and index

| Command | Description |
|---|---|
| `rail index build\|update\|status\|verify` | Build, incrementally update, inspect and verify the index |
| `rail context search QUERY` | Ranked evidence with provenance (`rail_search_context`) |
| `rail context symbol NAME`, `rail context references NAME` | Definitions, references and dependencies (`rail_get_symbol`) |
| `rail context impact --files A,B` | Impact, overlap and test recommendations (`rail_analyze_impact`) |
| `rail context pack --task TASK` | Budgeted context pack for a task |

### Workspaces, PRs, reviews, integration

| Command | Description |
|---|---|
| `rail workspace create\|list\|inspect\|clean` | Task worktrees; `clean` previews deletions and preserves recoverable artifacts |
| `rail pr import\|list\|show\|sync` | Track GitHub PRs |
| `rail pr submit --task TASK` | Publish or attach the task's PR through policy (`rail_submit_pr`) |
| `rail review request\|show --pr N` | Queue a review (`rail_request_review`) or read findings (`rail_get_review`) |
| `rail review invalidate --pr N` | Force re-evaluation of cached review evidence (operator) |
| `rail queue list\|status` | Integration queue (`rail_get_queue_status`) |
| `rail queue explain --pr N` | Why a PR is or is not merging |
| `rail queue tick` | Run one bounded scheduling and integration cycle (operator) |
| `rail queue pause\|resume` | Stop or restart integration (operator) |
| `rail integration candidate --pr N` | Request admission or show the candidate for a PR (`rail_request_integration`) |
| `rail integration validate\|status` | Validate the current candidate; show integration status |

### Service, events, dashboard

| Command | Description |
|---|---|
| `rail service run` | Run the scheduler, sessions, GitHub polling and reconciliation in the foreground |
| `rail service start\|stop\|status` | Background service control |
| `rail service install\|uninstall` | Install or remove a user service (systemd user unit, launchd agent, Windows task) |
| `rail sync` | Reconcile with GitHub now |
| `rail events list\|follow\|export` | Durable event log; `follow --json` streams JSONL from a cursor |
| `rail metrics show\|export` | Throughput, lead time, WIP, review reuse, usage and cost (unknown values are `unknown`, never zero) |
| `rail dashboard` | Terminal UI |
| `rail mcp` | MCP server over stdio; see [mcp.md](mcp.md) |

## Examples

```bash
rail init --repo .
rail account add --provider codex --name personal
rail agent create --name engineer --provider codex --account personal
rail index build
rail goal create --title "Add JWT authentication" --description-file goal.md
rail goal plan GOAL-1 --agent architect
rail service start
rail dashboard
rail queue explain --pr 148 --json
rail events follow --project current --json
```
