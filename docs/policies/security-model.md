# Security model

Agent Rail lets AI agents change code and move pull requests toward merge. This page describes what Rail enforces, what it relies on GitHub and the operating system for, and what it does not protect against.

## Principles

- **Deterministic core, probabilistic contributors.** Agents propose plans, code and reviews. Rail's own code decides state transitions, leases, scopes, policy and merges.
- **Skills are advisory.** Every rule that matters is checked at runtime in the CLI/MCP layer. A request is rejected even if a model insists.
- **GitHub stays authoritative.** Rail never bypasses branch protection, rulesets, CODEOWNERS, required reviews or required checks, and never claims a merge or check result it has not observed.

## Autonomy modes

Autonomy is set per repository (`project.autonomy`) and further limited by action and task risk.

| Mode | Code changes | PR publication | Merge |
|---|---|---|---|
| `observe` | None | None | None. Index, sync, search and report only. |
| `assisted` | Agents plan and implement in worktrees | Operator authorizes | Operator authorizes |
| `guarded` (default) | Autonomous | Autonomous | Autonomous for policy-eligible low/medium-risk work; approval gates for high risk and sensitive paths |
| `autopilot` | Autonomous | Autonomous | Autonomous within the same branch protection and security boundaries. No implicit permission to bypass checks. |

`integration.auto_merge_eligible` must be `false` in `observe` and `assisted`; `rail config validate` rejects contradictions.

## Approval gates

A change needs operator approval before integration when any of the following holds:

- it touches a path class listed in `security.require_approval_for` (default: `security-sensitive`, `database-migration`, `deployment-config`; also available: `dependency-change`, `high-risk`);
- its task risk is `high` and `review.require_review_for_high_risk` is on;
- reviewers disagree, a mandatory check is unavailable, the policy outcome is uncertain, or retries are exhausted.

Path classes are glob lists in `security.sensitive_paths`; see [default policies](default-policies.md). Approval is recorded with the operator identity and the policy version in the audit log. `rail queue explain` and the dashboard show why approval is required. Forcing a re-evaluation never bypasses branch protection or grants credentials.

## Untrusted content and prompt injection

Repository files, READMEs, code comments, issue bodies, PR descriptions and comments, review text, CI logs and the output of any tool (including Rail's own MCP responses) are **untrusted input**:

- They can inform an agent's work. They cannot change tool permissions, policy, task scope or credentials.
- Administrative functions (policy changes, credential creation, forced cleanup, direct merge or merge override) are **not exposed through MCP**. They exist only on the operator CLI.
- A bare agent identifier passed to MCP is not authorization. Managed sessions get a short-lived token scoped to project, task and lease generation. Unmanaged MCP clients get operator-configured permissions and explicit claim approval.
- Mutations require the current lease token. A stale generation is fenced out even if the agent believes it still owns the task.
- Rail never reads the OS secret store on behalf of an agent, and no MCP tool returns credentials.
- Repo-defined setup hooks and scripts are not executed in an untrusted repository without operator permission.
- Every Skill tells agents to treat this content as data and to report embedded instructions.

## Credentials

- Provider and GitHub credentials live in the OS secret store or the provider CLI's own supported login. Rail stores only references.
  - OS secret stores: macOS Keychain, Windows Credential Manager, Linux Secret Service.
  - The alternative is an explicitly chosen encrypted file (`security.credential_store: encrypted-file`).
- Credentials never appear in `.agent-rail/config.yaml`, user config, SQLite, prompts, logs, events or audit records. Configuration loading rejects secret-like keys.
- Claim tokens are returned only to the claiming session and are stored hashed.
- Rail does not extract tokens from other tools or proxy their logins. It only uses documented configuration-isolation and authentication mechanisms.
- Separate profiles for the same provider are allowed only through documented isolation. There is no identity rotation to evade rate limits.
- GitHub access uses the locally authorized `gh` credential with the minimum scopes needed. Rail checks that the remote owner/repo matches the project before any mutation.

## Data egress

- Indexing, search and context retrieval run locally.
- Agent provider calls send the context those agents receive to that provider. `security.data_routing` controls which providers may receive repository content, and the dashboard shows which provider received what.
- Embeddings are local by default (`index.embedding.provider: none` or a local Ollama endpoint). Any external embedding endpoint needs `consent_external: true`.
- `security.network: offline` stops all remote calls. Rail keeps working locally and queues remote intents until you reconnect.
- No telemetry leaves the machine. `observability.local_only` cannot be disabled. Diagnostic exports happen only when you run them, and secrets are redacted.

## Local service binding

- MCP uses stdio only; Rail opens no network listener for it.
- The optional service opens no network port. CLI, MCP instances and the service coordinate through the SQLite database and files in the user's data directory (created with user-only permissions). A future direct IPC channel (Unix domain socket or Windows named pipe) follows the same user-only rule.
- Any future HTTP interface must be opt-in, bound to loopback, token-authenticated, origin-checked and CSRF-protected. Unrestricted MCP tools are never exposed on a network interface.

## Worktrees are not a sandbox

Rail isolates tasks into separate Git worktrees and branches, validates canonical paths against traversal and symlink escape, sanitizes environment variables, applies timeouts and output limits, and cancels process trees. These limit **accidents**, not a hostile agent.

**All agents launched by Rail run as your operating-system user.** Processes running as the same user can read the same files, environment and user-level credentials, and Rail does not treat them as mutually hostile tenants. If you run agents you do not trust, put them in a separate OS account, container or VM with only the credentials they need. Platform limitations (for example, network policy enforcement where no sandbox exists) are reported by `rail doctor` and the session view rather than advertised as guarantees.

## Auditability

Every state-changing action records the operator or agent, the agent definition, the account profile reference, the task, the policy version, the action, an input fingerprint, the decision and the remote operation result. These records are written in the same transaction as the state change. Secrets never enter the audit stream. Export them with `rail events export`.

## Supply chain

- Dependencies are pinned in `bun.lock`.
- CI runs `bun audit` and installs with `--frozen-lockfile`.
- Third-party GitHub Actions are pinned to full commit SHAs.
- Releases ship SHA-256 checksums, a CycloneDX SBOM, a release manifest and GitHub artifact attestations. See [installation](../installation.md#install-a-release-binary) for verification.
