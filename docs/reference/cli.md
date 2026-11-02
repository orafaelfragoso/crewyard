# CLI reference

Generated from the `crew` 1.0.0 command tree by `bun scripts/gen-cli-reference.ts`. Do not edit by hand.

## Global conventions

- `--json`: machine output; a single JSON object (`{ "ok": true, "data": … }` or `{ "ok": false, "error": … }`), or JSONL for `events follow`. Progress goes to stderr.
- `--project NAME|ID`: select a project (default: the project of the current directory).
- Mutating commands accept `--dry-run` where meaningful and `-y/--yes` to confirm destructive or authorization-gated actions; without a TTY they refuse instead of prompting.
- Exit codes: 0 success, 2 invalid input, 3 conflict, 4 not authorized, 5 external failure, 6 unavailable/offline, 7 policy denied, 8 internal error. Errors carry a stable uppercase `code`, `message`, `retryable` and, when useful, `suggestion`.
- Timestamps are RFC 3339 UTC. Secrets and claim tokens are never printed except the claim token returned once by `task claim`.

## Commands

### `crew version`

print version and build information

### `crew doctor`

check runtime, tools, storage, providers, GitHub access and secret store

### `crew config`

show, validate and edit configuration

#### `crew config show`

show the effective configuration with sources (credentials redacted)

#### `crew config validate [file]`

validate a configuration file (default: the repository config)

#### `crew config set <path> <value>`

set a non-secret configuration value

| Option | Description |
|---|---|
| `--user` | write to the user configuration instead of the repository configuration |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew events`

inspect the durable event log

#### `crew events list`

list events (newest page by default)

| Option | Description |
|---|---|
| `--task <id>` |  |
| `--type <type...>` |  |
| `--before <seq>` | page older than this sequence |
| `--after <seq>` | page newer than this sequence |
| `--limit <n>` | page size (max 500) (default: `50`) |

#### `crew events follow`

stream new events (JSONL with --json); resumes from --after

| Option | Description |
|---|---|
| `--after <seq>` | resume after this sequence |
| `--task <id>` |  |

#### `crew events export <file>`

export events as JSONL (secrets are never stored in events)

### `crew metrics`

delivery, efficiency and usage metrics

#### `crew metrics show`



| Option | Description |
|---|---|
| `--days <n>` | window in days (default: `30`) |

#### `crew metrics export <file>`



| Option | Description |
|---|---|
| `--days <n>` | window in days (default: `30`) |
| `--format <format>` | json or csv (default: `json`) |

### `crew init`

register the repository, write .crewyard/config.yaml, index and print a readiness report

| Option | Description |
|---|---|
| `--repo <path>` | repository path (default: `.`) |
| `--base <branch>` | default base branch (detected from origin/HEAD otherwise) |
| `--name <name>` | project name |
| `--autonomy <mode>` | observe | assisted | guarded | autopilot |
| `--no-index` | skip the initial index |

### `crew project`

manage registered projects

#### `crew project add <path>`



| Option | Description |
|---|---|
| `--base <branch>` |  |
| `--name <name>` |  |

#### `crew project list`



#### `crew project show`



#### `crew project pause`



| Option | Description |
|---|---|
| `--workers` | pause/resume workers instead of intake |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew project resume`



| Option | Description |
|---|---|
| `--workers` | pause/resume workers instead of intake |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew project sync`

synchronize this project with GitHub

### `crew index`

build and inspect the versioned repository index

#### `crew index build`



| Option | Description |
|---|---|
| `--ref <ref>` | branch, tag or SHA to index (default: base branch) |
| `--worktree <path>` | index the HEAD of a worktree |
| `--force` | rebuild even if the snapshot exists |

#### `crew index update`



| Option | Description |
|---|---|
| `--ref <ref>` | branch, tag or SHA to index (default: base branch) |
| `--worktree <path>` | index the HEAD of a worktree |
| `--force` | rebuild even if the snapshot exists |

#### `crew index status`



| Option | Description |
|---|---|
| `--ref <ref>` |  |

#### `crew index verify`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sample <n>` | verify a random sample of blobs |

### `crew context`

version-aware retrieval with commit provenance

#### `crew context search <query>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--mode <mode>` | fts | exact | regex | path | symbol | hybrid (default: `hybrid`) |
| `--path <glob>` | restrict to paths (repeatable) |
| `--limit <n>` | max results (default: `20`) |

#### `crew context symbol <name>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` |  |
| `--deps <direction>` | imports | importedBy | both |

#### `crew context references <name>`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | definition path to disambiguate |

#### `crew context impact`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | changed path (repeatable) |
| `--symbol <name>` | changed symbol (repeatable) |

#### `crew context pack [query]`



| Option | Description |
|---|---|
| `--ref <ref>` |  |
| `--sha <sha>` |  |
| `--path <path>` | scope path (repeatable) |
| `--symbol <name>` | scope symbol (repeatable) |
| `--budget <tokens>` | token budget |
| `--cursor <cursor>` | fetch the next page of a previous pack |

### `crew goal`

goals and validated task plans

#### `crew goal create`



| Option | Description |
|---|---|
| `--title <title>` |  |
| `--description <text>` |  |
| `--description-file <file>` |  |

#### `crew goal plan <goalId>`

submit a task plan (--file plan.json|yaml) or ask a planning agent (--agent NAME)

| Option | Description |
|---|---|
| `--file <file>` | plan with {summary?, tasks:[{key,title,objective,acceptanceCriteria,dependencies,scopeHints,risk,...}]} |
| `--agent <name>` | planning agent |

#### `crew goal approve <goalId>`



| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew goal status [goalId]`



#### `crew goal cancel <goalId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew task`

tasks, leases and handoffs

#### `crew task add`



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

#### `crew task list`



| Option | Description |
|---|---|
| `--state <states>` | filter by states |
| `--goal <goalId>` |  |
| `--dispatchable` | only tasks that can be claimed now |
| `--limit <n>` | page size (default: `100`) |
| `--cursor <cursor>` |  |

#### `crew task show <taskId>`



#### `crew task next`



| Option | Description |
|---|---|
| `--agent <id>` | agent id or name |

#### `crew task explain <taskId>`

explain exactly why a task was or was not dispatched

#### `crew task claim <taskId>`



| Option | Description |
|---|---|
| `--agent <id>` | claiming agent id |
| `--no-workspace` | do not allocate a worktree |

#### `crew task heartbeat <taskId>`



| Option | Description |
|---|---|
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task start <taskId>`



| Option | Description |
|---|---|
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task release <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task report <taskId>`

store a progress checkpoint

| Option | Description |
|---|---|
| `--summary <text>` |  |
| `--percent <n>` | progress percent |
| `--commit <sha>` | commit (repeatable) |
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task complete <taskId>`

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
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task block <taskId>`

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
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task submit <taskId>`

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
| `--generation <n>` | lease generation returned by claim (or CREW_LEASE_GENERATION) |
| `--token <token>` | claim token returned by claim (or CREW_CLAIM_TOKEN) |

#### `crew task retry <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew task escalate <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |

#### `crew task ready <taskId>`

move a DRAFT task to READY

#### `crew task cancel <taskId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew task priority <taskId> <priority>`

operator priority override (use "clear" to remove)

#### `crew task pause <taskId>`



#### `crew task resume <taskId>`



#### `crew task assign <taskId> [agentId]`

assign (or with no agent, unassign) a task

#### `crew task approve <taskId>`



| Option | Description |
|---|---|
| `--reject` | reject instead of approve |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew workspace`

isolated per-task Git worktrees

#### `crew workspace create <taskId>`

allocate a worktree for a task you already hold a lease on (normally done by claim)

#### `crew workspace list`



#### `crew workspace inspect <workspaceId>`



#### `crew workspace clean`

preview, then remove abandoned worktrees (backups are saved first)

| Option | Description |
|---|---|
| `--authorize-dirty <reason>` | also remove worktrees with uncommitted/unpushed work (backups are kept) |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew account`

provider account profiles (credentials live in the OS secret store)

#### `crew account add`



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

#### `crew account list`



| Option | Description |
|---|---|
| `--provider <provider>` |  |

#### `crew account show <ref>`



#### `crew account test <ref>`

check CLI availability, authentication status and capabilities

#### `crew account remove <ref>`



| Option | Description |
|---|---|
| `--purge-config-root` | also delete the profile configuration directory |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew account policy <name>`

create an ordered account policy for agents

| Option | Description |
|---|---|
| `--profiles <refs>` | ordered profile refs |
| `--allow-fallback` | explicitly allow falling back to later profiles |
| `--models <models>` | model allowlist |

### `crew agent`

reusable agent definitions and managed sessions

#### `crew agent create`



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
| `--unmanaged` | register an external agent that Crewyard does not launch |

#### `crew agent list`



#### `crew agent show <agent>`



#### `crew agent run <agent>`

claim a task, allocate its worktree and run a managed session (stays attached until it ends)

| Option | Description |
|---|---|
| `--task <taskId>` |  |
| `--model <model>` |  |

#### `crew agent stop <sessionId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew agent sessions`



| Option | Description |
|---|---|
| `--agent <agent>` |  |
| `--task <taskId>` |  |

#### `crew agent logs <sessionId>`



| Option | Description |
|---|---|
| `--tail <bytes>` | only the last N bytes (default: `65536`) |

### `crew team`

teams of agents

#### `crew team create <name>`



| Option | Description |
|---|---|
| `--description <text>` |  |

#### `crew team list`



#### `crew team assign <team> <agent>`



| Option | Description |
|---|---|
| `--role <role>` |  |

### `crew install`

register the Crewyard MCP server and Skills with agent hosts

| Option | Description |
|---|---|
| `--target <hosts>` | codex,claude,opencode (default: all) |
| `--scope <scope>` | user | project (default: `user`) |
| `--instructions` | add/remove the bootstrap block in AGENTS.md / CLAUDE.md of this repository |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew uninstall`

remove only Crewyard-owned host configuration and restore backups

| Option | Description |
|---|---|
| `--target <hosts>` | codex,claude,opencode (default: all) |
| `--scope <scope>` | user | project (default: `user`) |
| `--instructions` | add/remove the bootstrap block in AGENTS.md / CLAUDE.md of this repository |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew hosts`

detect supported agent hosts and their Crewyard registration

### `crew service`

the long-running local worker for dispatch, sync, queue and recovery

#### `crew service run`

run the service in the foreground (what `service start` and the user service execute)

| Option | Description |
|---|---|
| `--tick <seconds>` | scheduling cycle interval |
| `--no-dispatch` | do not launch agent sessions (sync, queue and recovery only) |

#### `crew service start`

start the service in the background

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew service stop`



#### `crew service status`



#### `crew service install`

install a per-user service (systemd user unit, launchd agent or scheduled task)

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew service uninstall`



| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew dashboard`

interactive terminal dashboard (prints a static snapshot when not attached to a terminal)

| Option | Description |
|---|---|
| `--view <view>` | initial view: Overview, Projects, Tasks, Sessions, Queue, Context, Events, Metrics |
| `--snapshot` | print a static snapshot and exit |

### `crew sync`

synchronize PRs, reviews, checks, rules and merge state from GitHub

### `crew pr`

pull requests tracked by Crewyard

#### `crew pr import`

import existing open PRs and classify merge candidates, blockers and stacks

#### `crew pr list`



| Option | Description |
|---|---|
| `--state <state>` | open | closed | merged (default: `open`) |

#### `crew pr show <number>`



#### `crew pr sync <number>`



#### `crew pr submit`

push a handed-off task branch and open its PR (operator authorization for assisted mode)

| Option | Description |
|---|---|
| `--task <taskId>` |  |
| `--no-review` | skip Crewyard review |
| `--no-enqueue` | do not request integration |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew pr approve <number>`

authorize Crewyard to merge this PR head (assisted mode)

| Option | Description |
|---|---|
| `--reject` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew review`

evidence-fingerprinted reviews and findings

#### `crew review request <number>`



| Option | Description |
|---|---|
| `--type <types>` | code,security,integration |
| `--force` | re-review even when cached evidence matches |

#### `crew review show <numberOrReviewId>`



#### `crew review invalidate <number>`



| Option | Description |
|---|---|
| `--reason <text>` |  |

#### `crew review finding <findingId> <status>`

set a finding to accepted | dismissed | resolved | open

| Option | Description |
|---|---|
| `--note <text>` |  |

### `crew queue`

integration queue

#### `crew queue list`



#### `crew queue status`



| Option | Description |
|---|---|
| `--base <branch>` |  |

#### `crew queue explain`



| Option | Description |
|---|---|
| `--pr <number>` |  |

#### `crew queue add <number>`

request integration for a PR (idempotent)

| Option | Description |
|---|---|
| `--priority <n>` | priority |

#### `crew queue tick`

run one bounded integration cycle (requires leadership; fails if the service holds it)

#### `crew queue pause [queueId]`



#### `crew queue resume [queueId]`



#### `crew queue retry <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew queue quarantine <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew queue escalate <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

#### `crew queue remove <entryId>`



| Option | Description |
|---|---|
| `--reason <text>` |  |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew integration`

integration candidates and validation

#### `crew integration status`



#### `crew integration candidate [candidateId]`

show a candidate or list recent candidates for the base-branch queue

#### `crew integration validate`

build and validate the next candidate now (one leader-only queue cycle)

### `crew backup`

consistent local state backups (credentials are never included)

#### `crew backup create`



| Option | Description |
|---|---|
| `--label <label>` | file label (default: `manual`) |

#### `crew backup list`



#### `crew backup verify <file>`



#### `crew backup restore <file>`

replace local state with a backup (a safety backup is taken first)

| Option | Description |
|---|---|
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew gc`

preview (default) or apply retention: unreferenced index data, abandoned worktrees, old events, old backups

| Option | Description |
|---|---|
| `--apply` | apply the plan (events are archived to JSONL before deletion) |
| `--keep-backups <n>` | backups to keep (default: `10`) |
| `--dry-run` | preview the change without applying it |
| `-y, --yes` | confirm destructive or authorization-gated actions |

### `crew recover`

run startup recovery now: processes, leases, workspaces, outbox and GitHub reconciliation

| Option | Description |
|---|---|
| `--kill-orphans` | terminate live orphaned agent process groups |

### `crew mcp`

run the MCP stdio server (stdout carries protocol messages only)
