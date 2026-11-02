# CLI reference

Generated from the `rail` 1.0.0 command tree by `bun scripts/gen-cli-reference.ts`. Do not edit by hand.

## Global conventions

- `--json`: machine output; a single JSON object (`{ "ok": true, "data": … }` or `{ "ok": false, "error": … }`), or JSONL for `events follow`. Progress goes to stderr.
- `--project NAME|ID`: select a project (default: the project of the current directory).
- Mutating commands accept `--dry-run` where meaningful and `-y/--yes` to confirm destructive or authorization-gated actions; without a TTY they refuse instead of prompting.
- Exit codes: 0 success, 2 invalid input, 3 conflict, 4 not authorized, 5 external failure, 6 unavailable/offline, 7 policy denied, 8 internal error. Errors carry a stable uppercase `code`, `message`, `retryable` and, when useful, `suggestion`.
- Timestamps are RFC 3339 UTC. Secrets and claim tokens are never printed except the claim token returned once by `task claim`.

## Commands

### `rail version`

print version and build information

### `rail doctor`

check runtime, tools, storage, providers, GitHub access and secret store

### `rail config`

show, validate and edit configuration

#### `rail config show`

show the effective configuration with sources (credentials redacted)

#### `rail config validate [file]`

validate a configuration file (default: the repository config)

#### `rail config set <path> <value>`

set a non-secret configuration value

| Option | Description |
|---|---|
| `--user` | write to the user configuration instead of the repository configuration |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail events`

inspect the durable event log

#### `rail events list`

list events (newest page by default)

| Option | Description |
|---|---|
| `--task <id>` |  |
| `--type <type...>` |  |
| `--before <seq>` | page older than this sequence |
| `--after <seq>` | page newer than this sequence |
| `--limit <n>` | page size (max 500) (default: `50`) |

#### `rail events follow`

stream new events (JSONL with --json); resumes from --after

| Option | Description |
|---|---|
| `--after <seq>` | resume after this sequence |
| `--task <id>` |  |

#### `rail events export <file>`

export events as JSONL (secrets are never stored in events)

### `rail metrics`

delivery, efficiency and usage metrics

#### `rail metrics show`



| Option | Description |
|---|---|
| `--days <n>` | window in days (default: `30`) |

#### `rail metrics export <file>`



| Option | Description |
|---|---|
| `--days <n>` | window in days (default: `30`) |
| `--format <format>` | json or csv (default: `json`) |

### `rail init`

register the repository, write .agent-rail/config.yaml, index and print a readiness report

| Option | Description |
|---|---|
| `--repo <path>` | repository path (default: `.`) |
| `--base <branch>` | default base branch (detected from origin/HEAD otherwise) |
| `--name <name>` | project name |
| `--autonomy <mode>` | observe | assisted | guarded | autopilot |
| `--no-index` | skip the initial index |

### `rail project`

manage registered projects

#### `rail project add <path>`



| Option | Description |
|---|---|
| `--base <branch>` |  |
| `--name <name>` |  |

#### `rail project list`



#### `rail project show`



#### `rail project pause`



| Option | Description |
|---|---|
| `--workers` | pause/resume workers instead of intake |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail project resume`



| Option | Description |
|---|---|
| `--workers` | pause/resume workers instead of intake |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail project sync`

synchronize this project with GitHub

### `rail index`

build and inspect the versioned repository index

#### `rail index build`



| Option | Description |
|---|---|
| `--ref <ref>` | branch, tag or SHA to index (default: base branch) |
| `--worktree <path>` | index the HEAD of a worktree |
| `--force` | rebuild even if the snapshot exists |

#### `rail index update`



| Option | Description |
|---|---|
| `--ref <ref>` | branch, tag or SHA to index (default: base branch) |
| `--worktree <path>` | index the HEAD of a worktree |
| `--force` | rebuild even if the snapshot exists |

#### `rail index status`



| Option | Description |
|---|---|
| `--ref <ref>` |  |

#### `rail index verify`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sample <n>` | verify a random sample of blobs |

### `rail context`

version-aware retrieval with commit provenance

#### `rail context search <query>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--mode <mode>` | fts | exact | regex | path | symbol | hybrid (default: `hybrid`) |
| `--path <glob>` | restrict to paths (repeatable) |
| `--limit <n>` | max results (default: `20`) |

#### `rail context symbol <name>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` |  |
| `--deps <direction>` | imports | importedBy | both |

#### `rail context references <name>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | definition path to disambiguate |

#### `rail context impact`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | changed path (repeatable) |
| `--symbol <name>` | changed symbol (repeatable) |

#### `rail context pack [query]`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | scope path (repeatable) |
| `--symbol <name>` | scope symbol (repeatable) |
| `--budget <tokens>` | token budget |
| `--cursor <cursor>` | fetch the next page of a previous pack |

### `rail goal`

goals and validated task plans

#### `rail goal create`



| Option | Description |
|---|---|
| `--title <title>` |  |
| `--description <text>` |  |
| `--description-file <file>` |  |

#### `rail goal plan <goalId>`

submit a task plan (--file plan.json|yaml) or ask a planning agent (--agent NAME)

| Option | Description |
|---|---|
| `--file <file>` | plan with {summary?, tasks:[{key,title,objective,acceptanceCriteria,dependencies,scopeHints,risk,...}]} |
| `--agent <name>` | planning agent |

#### `rail goal approve <goalId>`



| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail goal status [goalId]`



#### `rail goal cancel <goalId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail task`

tasks, leases and handoffs

#### `rail task add`



| Option | Description |
|---|---|
| `--title <title>` |  |
| `--objective <text>` |  |
| `--criteria <text>` | acceptance criterion (repeatable) |
| `--depends-on <ids>` | dependency task ids |
| `--scope <paths>` | scope hints (paths/globs or resource:name) |
| `--exclusive <resources>` | exclusive resources |
| `--risk <risk>` | low | medium | high (default: `medium`) |
| `--priority <n>` | 0-100 (default: `50`) |
| `--role <role>` | requested agent role |
| `--goal <goalId>` |  |
| `--ready` | mark READY immediately (default: DRAFT) |

#### `rail task list`



| Option | Description |
|---|---|
| `--state <states>` | filter by states |
| `--goal <goalId>` |  |
| `--dispatchable` | only tasks that can be claimed now |
| `--limit <n>` | page size (default: `100`) |
| `--cursor <cursor>` |  |

#### `rail task show <taskId>`



#### `rail task next`



| Option | Description |
|---|---|
| `--agent <id>` | agent id or name |

#### `rail task explain <taskId>`

explain exactly why a task was or was not dispatched

#### `rail task claim <taskId>`



| Option | Description |
|---|---|
| `--agent <id>` | claiming agent id |
| `--no-workspace` | do not allocate a worktree |

#### `rail task heartbeat <taskId>`



| Option | Description |
|---|---|
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task start <taskId>`



| Option | Description |
|---|---|
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task release <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task report <taskId>`

store a progress checkpoint

| Option | Description |
|---|---|
| `--summary <text>` |  |
| `--percent <n>` | progress percent |
| `--commit <sha>` | commit (repeatable) |
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task complete <taskId>`

hand off finished work

| Option | Description |
|---|---|
| `--summary <text>` | what was done / why it is blocked |
| `--worktree <path>` |  |
| `--commit <sha>` | commit id (repeatable) |
| `--evidence-file <file>` | JSON array of test evidence {command, exitCode, durationMs, outputRef?, commitSha} |
| `--context-pack <id>` | context pack id (repeatable) |
| `--issue <text>` | remaining issue (repeatable) |
| `--kind <kind>` | blocked | needs_review | ready_for_pr | completed (default: `completed`) |
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task block <taskId>`

report a blocker and release resources

| Option | Description |
|---|---|
| `--summary <text>` | what was done / why it is blocked |
| `--worktree <path>` |  |
| `--commit <sha>` | commit id (repeatable) |
| `--evidence-file <file>` | JSON array of test evidence {command, exitCode, durationMs, outputRef?, commitSha} |
| `--context-pack <id>` | context pack id (repeatable) |
| `--issue <text>` | remaining issue (repeatable) |
| `--kind <kind>` | blocked | needs_review | ready_for_pr | completed (default: `blocked`) |
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task submit <taskId>`

hand off work that is ready for a PR

| Option | Description |
|---|---|
| `--summary <text>` | what was done / why it is blocked |
| `--worktree <path>` |  |
| `--commit <sha>` | commit id (repeatable) |
| `--evidence-file <file>` | JSON array of test evidence {command, exitCode, durationMs, outputRef?, commitSha} |
| `--context-pack <id>` | context pack id (repeatable) |
| `--issue <text>` | remaining issue (repeatable) |
| `--kind <kind>` | blocked | needs_review | ready_for_pr | completed (default: `ready_for_pr`) |
| `--generation <n>` | lease generation returned by claim (or RAIL_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or RAIL_CLAIM_TOKEN) |

#### `rail task retry <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail task escalate <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |

#### `rail task ready <taskId>`

move a DRAFT task to READY

#### `rail task cancel <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail task priority <taskId> <priority>`

operator priority override (use "clear" to remove)

#### `rail task pause <taskId>`



#### `rail task resume <taskId>`



#### `rail task assign <taskId> [agentId]`

assign (or with no agent, unassign) a task

#### `rail task approve <taskId>`



| Option | Description |
|---|---|
| `--reject` | reject instead of approve |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail workspace`

isolated per-task Git worktrees

#### `rail workspace create <taskId>`

allocate a worktree for a task you already hold a lease on (normally done by claim)

#### `rail workspace list`



#### `rail workspace inspect <workspaceId>`



#### `rail workspace clean`

preview, then remove abandoned worktrees (backups are saved first)

| Option | Description |
|---|---|
| `--authorize-dirty <reason>` | also remove worktrees with uncommitted/unpushed work (backups are kept) |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail account`

provider account profiles (credentials live in the OS secret store)

#### `rail account add`



| Option | Description |
|---|---|
| `--provider <provider>` | codex | claude | opencode | generic | ollama |
| `--name <name>` | profile name, unique per provider |
| `--display-name <name>` |  |
| `--auth <mechanism>` | cli-login | api-key | local | none |
| `--api-key-stdin` | read an API key from stdin (hidden prompt on a TTY) |
| `--api-key-env <var>` | read an API key once from this environment variable |
| `--config-root <dir>` | provider configuration directory for this profile (documented isolation) |
| `--use-default-config` | use the provider's default configuration directory (single profile only) |
| `--models <models>` | permitted models |
| `--concurrency <n>` | max concurrent sessions |
| `--command <cmd...>` | generic provider: executable and arguments |
| `--endpoint <url>` | ollama endpoint |

#### `rail account list`



| Option | Description |
|---|---|
| `--provider <provider>` |  |

#### `rail account show <ref>`



#### `rail account test <ref>`

check CLI availability, authentication status and capabilities

#### `rail account remove <ref>`



| Option | Description |
|---|---|
| `--purge-config-root` | also delete the profile configuration directory |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail account policy <name>`

create an ordered account policy for agents

| Option | Description |
|---|---|
| `--profiles <refs>` | ordered profile refs |
| `--allow-fallback` | explicitly allow falling back to later profiles |
| `--models <models>` | model allowlist |

### `rail agent`

reusable agent definitions and managed sessions

#### `rail agent create`



| Option | Description |
|---|---|
| `--name <name>` |  |
| `--role <role>` | engineer | architect | reviewer | ... (default: `engineer`) |
| `--provider <provider>` | preferred provider |
| `--model <model>` | preferred model |
| `--account <ref>` | account profile ref (creates a single-profile policy) |
| `--policy <name>` | account policy name |
| `--instructions <text>` | system instructions |
| `--skills <names>` | skills |
| `--tools <names>` | allowed MCP tools (default: all agent tools) |
| `--review-authority <level>` | none | advisory | required |
| `--max-parallel <n>` | max concurrent sessions |
| `--unmanaged` | register an external agent that Rail does not launch |

#### `rail agent list`



#### `rail agent show <agent>`



#### `rail agent run <agent>`

claim a task, allocate its worktree and run a managed session (stays attached until it ends)

| Option | Description |
|---|---|
| `--task <taskId>` |  |
| `--model <model>` |  |

#### `rail agent stop <sessionId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail agent sessions`



| Option | Description |
|---|---|
| `--agent <agent>` |  |
| `--task <taskId>` |  |

#### `rail agent logs <sessionId>`



| Option | Description |
|---|---|
| `--tail <bytes>` | only the last N bytes (default: `65536`) |

### `rail team`

teams of agents

#### `rail team create <name>`



| Option | Description |
|---|---|
| `--description <text>` |  |

#### `rail team list`



#### `rail team assign <team> <agent>`



| Option | Description |
|---|---|
| `--role <role>` |  |

### `rail install`

register the Rail MCP server and Skills with agent hosts

| Option | Description |
|---|---|
| `--target <hosts>` | codex,claude,opencode (default: all) |
| `--scope <scope>` | user | project (default: `user`) |
| `--instructions` | add/remove the bootstrap block in AGENTS.md / CLAUDE.md of this repository |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail uninstall`

remove only Rail-owned host configuration and restore backups

| Option | Description |
|---|---|
| `--target <hosts>` | codex,claude,opencode (default: all) |
| `--scope <scope>` | user | project (default: `user`) |
| `--instructions` | add/remove the bootstrap block in AGENTS.md / CLAUDE.md of this repository |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail hosts`

detect supported agent hosts and their Rail registration

### `rail service`

the long-running local worker for dispatch, sync, queue and recovery

#### `rail service run`

run the service in the foreground (what `service start` and the user service execute)

| Option | Description |
|---|---|
| `--tick <seconds>` | scheduling cycle interval |
| `--no-dispatch` | do not launch agent sessions (sync, queue and recovery only) |

#### `rail service start`

start the service in the background

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail service stop`



#### `rail service status`



#### `rail service install`

install a per-user service (systemd user unit, launchd agent or scheduled task)

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail service uninstall`



| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail dashboard`

interactive terminal dashboard (prints a static snapshot when not attached to a terminal)

| Option | Description |
|---|---|
| `--view <view>` | initial view: Overview, Projects, Tasks, Sessions, Queue, Context, Events, Metrics |
| `--snapshot` | print a static snapshot and exit |

### `rail sync`

synchronize PRs, reviews, checks, rules and merge state from GitHub

### `rail pr`

pull requests tracked by Rail

#### `rail pr import`

import existing open PRs and classify merge candidates, blockers and stacks

#### `rail pr list`



| Option | Description |
|---|---|
| `--state <state>` | open | closed | merged (default: `open`) |

#### `rail pr show <number>`



#### `rail pr sync <number>`



#### `rail pr submit`

push a handed-off task branch and open its PR (operator authorization for assisted mode)

| Option | Description |
|---|---|
| `--task <taskId>` |  |
| `--no-review` | skip Rail review |
| `--no-enqueue` | do not request integration |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail pr approve <number>`

authorize Rail to merge this PR head (assisted mode)

| Option | Description |
|---|---|
| `--reject` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail review`

evidence-fingerprinted reviews and findings

#### `rail review request <number>`



| Option | Description |
|---|---|
| `--type <types>` | code,security,integration |
| `--force` | re-review even when cached evidence matches |

#### `rail review show <numberOrReviewId>`



#### `rail review invalidate <number>`



| Option | Description |
|---|---|
| `--reason <text>` |  |

#### `rail review finding <findingId> <status>`

set a finding to accepted | dismissed | resolved | open

| Option | Description |
|---|---|
| `--note <text>` |  |

### `rail queue`

integration queue

#### `rail queue list`



#### `rail queue status`



| Option | Description |
|---|---|
| `--base <branch>` |  |

#### `rail queue explain`



| Option | Description |
|---|---|
| `--pr <number>` |  |

#### `rail queue add <number>`

request integration for a PR (idempotent)

| Option | Description |
|---|---|
| `--priority <n>` | priority |

#### `rail queue tick`

run one bounded integration cycle (requires leadership; fails if the service holds it)

#### `rail queue pause [queueId]`



#### `rail queue resume [queueId]`



#### `rail queue retry <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail queue quarantine <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail queue escalate <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `rail queue remove <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail integration`

integration candidates and validation

#### `rail integration status`



#### `rail integration candidate [candidateId]`

show a candidate or list recent candidates for the base-branch queue

#### `rail integration validate`

build and validate the next candidate now (one leader-only queue cycle)

### `rail backup`

consistent local state backups (credentials are never included)

#### `rail backup create`



| Option | Description |
|---|---|
| `--label <label>` | file label (default: `manual`) |

#### `rail backup list`



#### `rail backup verify <file>`



#### `rail backup restore <file>`

replace local state with a backup (a safety backup is taken first)

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail gc`

preview (default) or apply retention: unreferenced index data, abandoned worktrees, old events, old backups

| Option | Description |
|---|---|
| `--apply` | apply the plan (events are archived to JSONL before deletion) |
| `--keep-backups <n>` | backups to keep (default: `10`) |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `rail recover`

run startup recovery now: processes, leases, workspaces, outbox and GitHub reconciliation

| Option | Description |
|---|---|
| `--kill-orphans` | terminate live orphaned agent process groups |

### `rail mcp`

run the MCP stdio server (stdout carries protocol messages only)
