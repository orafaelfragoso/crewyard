# MCP reference

`crew mcp` is an MCP server over stdio, built on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). Each agent host spawns its own instance, and several can run at once. Protocol messages go to stdout and diagnostics to stderr. Registration per host: [mcp-hosts.md](../mcp-hosts.md).

Tool inputs and outputs are versioned JSON schemas validated with Zod v4. Tool names are stable for v1. Optional fields may be added; breaking changes need a new tool version.

## Response envelope

Every tool returns one JSON object:

```json
{
  "ok": true,
  "operationId": "op_01...",
  "data": {
    "taskId": "TASK-101",
    "leaseGeneration": 4,
    "leaseExpiresAt": "2026-11-02T21:15:00Z",
    "workspaceId": "ws_01...",
    "worktreePath": "/home/user/.local/share/crewyard/worktrees/ws_01..."
  },
  "revision": 19
}
```

```json
{
  "ok": false,
  "operationId": "op_01...",
  "error": {
    "code": "STALE_LEASE",
    "message": "Lease generation 3 is no longer current for TASK-101",
    "retryable": false,
    "suggestion": "Stop writing and call crew_get_next_action."
  },
  "revision": 21
}
```

- `operationId` correlates the tool-call envelope. It is separate from durable execution attempt and outbox operation IDs.
- `revision` is the state revision the response reflects.
- Error codes and exit-code classes are the same as the CLI ([cli.md](cli.md#global-conventions)).
- Context results carry provenance: repository, commit SHA, retrieval time and index status (`fresh`, `stale`, `building`, `failed`, `missing`).
- The claim token is returned only to the claiming session and is redacted from logs and events. Paths are examples; the data directory depends on the OS.

## Tools

| Tool | Purpose | Mutating | CLI equivalent |
|---|---|---|---|
| `crew_get_state` | Project, queue, task and worker status, and the policy in force | No | `crew project show --json` |
| `crew_search_context` | Ranked evidence with commit provenance | No | `crew context search QUERY --json` |
| `crew_get_symbol` | Definition, references and dependency context | No | `crew context symbol NAME --json` |
| `crew_analyze_impact` | Impact, overlap with leased scopes and open PRs, test recommendations, confidence tier | No | `crew context impact --files A,B --json` |
| `crew_list_tasks` | Query the current task DAG | No | `crew task list --json` |
| `crew_get_next_action` | Safe suggested next action for the calling agent | No | `crew task next --agent ID --json` |
| `crew_claim_task` | Acquire a task lease and scope reservations; returns the worktree | Yes | `crew task claim TASK --agent ID --json` |
| `crew_heartbeat` | Renew a valid lease (current generation only) | Yes | `crew task heartbeat TASK --json` |
| `crew_report_progress` | Store structured progress or a checkpoint | Yes | `crew task report TASK --summary SUMMARY --json` |
| `crew_report_blocker` | Report a blocker and release or replan resources | Yes | `crew task block TASK --summary SUMMARY --json` |
| `crew_submit_work` | Register commit, test and worktree evidence (`needs_review`, `ready_for_pr`, `completed`); use `crew_report_blocker` for a blocker | Yes | `crew task submit TASK --kind KIND --summary SUMMARY --json` |
| `crew_submit_pr` | Attach or publish a PR through the policy-controlled path | Yes | `crew pr submit --task TASK --json` |
| `crew_get_review` | Review history and open findings for the task or PR | No | `crew review show N --json` |
| `crew_request_review` | Drive or join a review of the calling task's PR under current evidence rules | Yes | `crew review request N --json` |
| `crew_request_integration` | Request admission to the integration queue | Yes | `crew queue add N --json` |
| `crew_get_queue_status` | Queue position and blockers | No | `crew queue explain --pr N --json` |

Mutating tools require the caller's current lease where they act on a task. A stale generation is rejected with `STALE_LEASE`, and policy gates return `APPROVAL_REQUIRED` or `POLICY_DENIED`.

CLI holder commands also need the claim's generation and token, supplied through `--generation`/`--token` or
`CREW_LEASE_GENERATION`/`CREW_CLAIM_TOKEN`. The table shows command forms; use the task's actual handoff evidence
and required approvals. Never commit tokens to a script or repository.

`crew_request_review` accepts `{ taskId }` and awaits the shared application review path. It does not expose a
`force` input; the operator CLI offers `crew review request N --force`. Current source/context, reviewer/model,
policy, security and TTL rules decide whether completed evidence may be reused or active work joined. Joining
is not a completed cache hit, and a crash can repeat provider work. Historical artifacts returned by
`crew_get_review` are not automatically current integration authority.

Long operations drive or join bounded subprocess execution even without a resident service. Closing the host
does not guarantee continuation. A tool marked non-mutating grants no task/integration mutation authority;
context retrieval can still build an exact-commit index on demand and persist local cache/context artifacts.
Snapshot reader claims protect retrieval across awaited work. See [execution](../architecture/overview.md#processes)
and [review evidence](../architecture/integration.md#review-evidence).

**Not exposed through MCP:** policy changes, credential creation, forced cleanup, direct merge or merge override, queue tick/pause, and service control. These are operator CLI actions only.

## Identity

- A caller-supplied agent identifier is not authorization.
- Managed sessions (launched by Crewyard) receive a short-lived token scoped to project, task and lease generation.
- Unmanaged clients act under operator-configured permissions and explicit claim approval or limited scopes. For them, automatic cancellation, workspace enforcement and usage accounting may be unavailable, and Crewyard reports this.

## Resources

All resources are read-only, scoped to the session's authorized project, paged and size-limited.

| URI | Content |
|---|---|
| `crew://project/{id}/overview` | Project, repositories, policy, index freshness, worker status |
| `crew://task/{id}` | Task record: state, dependencies, lease, scope, evidence, handoff |
| `crew://repository/{id}/snapshot/{sha}` | Indexed snapshot metadata for a commit |
| `crew://queue/{id}` | Integration queue entries, candidates and blockers |

## Prompt

`execution-handoff`: builds the handoff message for a task (objective, acceptance criteria, worktree, lease rules and the evidence to submit), so a host can start or resume execution without extra hand-written instructions.
