# Provider adapters, accounts and managed sessions

Packages: `@agent-rail/provider-{codex,claude,opencode,generic,ollama}`, `@agent-rail/agents`.

Agent identities (agents), LLM accounts (profiles), routing rules (account policies) and running processes (sessions)
are separate records. An agent references an **account policy**, never a credential.

## Adapter contract

Every adapter implements `ProviderAdapter` from `@agent-rail/core`:

| Operation | Behaviour |
|---|---|
| `capabilities(profile)` | Feature detection: binary presence/version, structured events, usage level, resume, isolation kind, coding vs planning/review. |
| `validateProfile(profile)` | Auth status through the provider's documented status command; `unknown` with an explanation when no offline check exists (API keys). |
| `launch(input)` | Spawns a detached process group in `input.cwd` with a sanitized environment (core `DEFAULT_ENV_ALLOWLIST`), the profile's isolation variables, `RAIL_*` session variables and, only for `api-key` profiles, the key resolved from the OS secret store. Streams stdout into normalized `AgentEvent`s, writes a redacted raw log to `input.logPath`, enforces `timeoutMs` and `maxOutputBytes`. |
| `cancel(sessionId)` | SIGTERM to the process group, SIGKILL to the whole group after the grace period. |

Unsupported operations throw `UNSUPPORTED_CAPABILITY` (for example output schemas on OpenCode, coding execution on
Ollama unless explicitly enabled).

The CLI adapters share one runtime (`ProcessSessions` in `@agent-rail/provider-generic`): line splitting, a per-provider
`StreamDecoder`, exact-value secret redaction plus core `redact`, output limits, timeouts and process-group kill. Codex,
Claude, OpenCode and Ollama depend on `@agent-rail/provider-generic` for that runtime; it depends only on core.

### Normalized events

`started` (once at spawn with the pid, again with `providerSessionId` when the provider reports it), `message`, `tool`
(`started`/`completed`/`failed`), `usage`, `log` (stderr and non-protocol stdout), `error` (with a `FailureClass`) and
`completed` (outcome, exit code, result excerpt).

### Usage and cost

| Provider | Tokens | Cost |
|---|---|---|
| Codex | measured (`turn.completed.usage`, summed per turn) | unknown, configured rate only |
| Claude Code | measured (`result.modelUsage`, else `result.usage`) | reported (`costUSD` / `total_cost_usd`, a client-side estimate) |
| OpenCode | measured (`step_finish.part.tokens`, summed per step) | reported (`step_finish.part.cost`) |
| Ollama | measured (`prompt_eval_count`, `eval_count`) | unknown, configured rate only |
| Generic | measured only if the process emits `usage` lines | reported only if it emits `cost_usd` |

`inputTokens` always includes cache reads and writes; `cachedTokens` is the cache-read portion. Missing usage is stored as
`NULL` with `usage_source = 'unknown'`, never as zero. Cost is `reported` when the provider reports it, otherwise
`configured_rate` from `observability.rates` when tokens were measured, otherwise `NULL`/`unknown`.

### Failure classes

Decoders classify provider errors (HTTP status where reported, Claude's typed assistant errors, otherwise message text);
otherwise stderr and exit codes are classified: rate limits → `rate_limited`, 401/403/not logged in →
`authentication`, connection errors → `transient_network`, 5xx/overloaded → `transient_provider`, output limit →
`policy_violation`. Rate limits set `provider_health.rate_limited_until` from a `retry after`/`try again in` hint or 15
minutes; authentication failures mark the profile `unauthenticated`; three consecutive transient failures mark it
`degraded`.

## Account profiles

`addProfile` / `listProfiles` / `getProfile` / `testProfile` / `removeProfile` back `rail account add|list|show|test|remove`.

- Isolation: Codex, Claude and OpenCode profiles get a private config root at `<data>/profiles/<provider>/<name>`
  (or a user-specified directory). One profile per provider may use the provider's default configuration
  (`useProviderDefaultConfig`). Two profiles can never share a config root. Log in to an isolated profile with the
  command returned by `profileLoginCommand` (for example `CODEX_HOME=<root> codex login`).
- Credentials: `api-key` profiles store the key with `Bun.secrets` (service `agent-rail`, name
  `profile.<provider>.<name>`); SQLite only keeps that reference. Removing the profile deletes the secret. Settings are
  rejected if they contain secret-looking keys or values.
- Health: `provider_health` keeps status, `rate_limited_until`, consecutive failures and the last error. `testProfile`
  never clears an unexpired rate limit.

There is no identity rotation: profiles are separate accounts the operator owns, and fallback between them is opt-in.

## Account policies and routing

An account policy is an ordered profile list, an explicit `allow_fallback` flag and a model allowlist.
`routeAgent(ctx, { agentId, taskId?, requiredCapability, model? })`:

1. Static eligibility, in policy order: provider supports the mode, data routing allows the provider, the model is
   permitted by the profile and the policy. Skipping a statically ineligible profile is not a fallback.
2. The first permitted profile is the primary. Later permitted profiles are tried only when the policy's
   `allow_fallback` or `agents.allow_profile_fallback` is true.
3. Each candidate must be healthy enough (not unexpired `rate_limited`, not `unauthenticated`/`unavailable`), under
   `max_concurrency` (sessions in `starting|running|stopping`) and within every applicable budget (profile, agent, task,
   project, global; measured usage only; unknown usage is reported as such).

The decision carries an explanation list stored on the session and on the task (`routing_explanation`). If nothing is
eligible the error is typed: `BUSY` (capacity), `RATE_LIMITED` (with `details.retryAt`, AT-17: work pauses unless a
fallback is authorized), `UNAVAILABLE` (health) or `POLICY_DENIED` (budget, model, data routing).

## Managed sessions

`startManagedSession(ctx, { agentId, taskId?, projectId?, cwd, prompt, mode, model?, leaseBinding? })` routes inside the
same `BEGIN IMMEDIATE` transaction that inserts the `sessions` row, so capacity checks are atomic. The process is
launched after commit; events stream into `session_events` (`agent.*` types, per-session `seq`) and refresh
`last_heartbeat_at`. A heartbeat timer keeps `last_heartbeat_at` fresh for quiet sessions. Logs live at
`<logs>/<session-id>/session.log`. On completion the session row, one `session_usage` row, profile health and a
`session.<state>` event plus audit row are written in one transaction.

- `awaitSession` waits in-process or polls the database. `stopSession` cancels through the adapter, then kills the
  process group after `agents.cancel_grace_seconds`; from another process it kills the recorded group only if the
  recorded process start time still matches.
- `reapOrphans(ctx, { killLiveOrphans? })` is idempotent: sessions whose process is gone become `lost`; live processes
  without a live supervisor become `orphaned`, and are killed (`cancelled`) only when asked and only if the process
  identity can be verified.

### Session tokens (FR-AGT-07)

Each managed session gets a fresh `rail_…` token. Only `hashToken(token)` is stored (`sessions.session_token_hash`). The
binding (project, task, lease generation, expiry = session timeout + grace + 60 s) is recorded as a `token.issued`
session event. The child receives `RAIL_SESSION_TOKEN`, `RAIL_SESSION_ID`, `RAIL_AGENT_ID`, `RAIL_TASK_ID` and
`RAIL_PROJECT_ID`. `verifySessionToken(ctx, token)` returns the binding only while the session is active, the token is
unexpired and the task's active lease still has the bound generation; otherwise `NOT_AUTHORIZED`. The hash is cleared
when the session ends. The token value is redacted from events and logs by exact match and by the core `rail_` pattern.

## Unmanaged agents (FR-AGT-08)

`registerUnmanagedAgent` records an external identity (`managed = 0`) with operator-configured MCP tools and path
scopes. `agent.limitations` lists what Rail cannot do for it: no automatic cancellation, no workspace enforcement, no
usage accounting. Unmanaged agents are never routed or launched.

## Data egress (FR-SEC-03)

`dataRoutingDecision(config, providerId, profile?)` applies `security.data_routing` rules keyed by
`<provider>/<profile>`, `<provider>` or `*`, then denies non-local providers when `security.network` is `offline`. Each
decision carries a disclosure of what the provider receives.

## Limitations

- Worktrees are not a security sandbox. Agents run as the operator's OS user; filesystem confinement is whatever the
  provider's own sandbox offers (Codex `--sandbox`, Claude permission modes).
- Prompts for OpenCode are passed as an argument (visible in the process list); Codex, Claude and generic agents read the
  prompt from stdin.
- Process identity checks use `/proc/<pid>/stat` on Linux and `ps -o lstart` on macOS; on Windows the reaper never
  kills live orphans.
