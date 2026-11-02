# GitHub connection, queue modes and stacks

Packages: `@agent-rail/github` (typed REST/GraphQL client), `@agent-rail/integration` (sync, eligibility, queue,
candidates, merges), `@agent-rail/reviews` (review evidence and validation runs).

GitHub stays authoritative for merges, required checks, reviews and branch rules (ADR-005). Rail never bypasses
branch protection, rulesets, CODEOWNERS or required reviews (FR-SEC-05); a passing Rail review never replaces a GitHub
check (FR-GH-03).

## Credentials and identities

- The token comes from `gh auth token --hostname <host>`. Rail runs `gh` with a minimal environment and, when the
  repository has a `gh` configuration directory (`repositories.gh_config_dir`), sets `GH_CONFIG_DIR` to that directory. Several GitHub identities
  therefore work side by side: one `gh` configuration directory per identity, selected per repository.
- The token is cached in process memory only. It is never written to SQLite, events, audit rows, logs or error
  details. `GH_TOKEN`/`GITHUB_TOKEN` are honoured because `gh` honours them.
- GitHub Enterprise Server is supported through the remote host: the API base becomes `https://<host>/api/v3` and
  GraphQL `https://<host>/api/graphql`.

### Minimum permissions

| Capability | Classic OAuth scope (`gh auth login`) | Fine-grained token / GitHub App permission |
|---|---|---|
| Read PRs, files, reviews | `repo` (private) or `public_repo` | Pull requests: read, Metadata: read |
| Checks, statuses, workflow runs | same | Checks: read, Commit statuses: read, Actions: read |
| Branch rules (`/rules/branches`) | same | Metadata: read |
| Classic branch protection (optional) | same, admin on the repository | Administration: read |
| Create/update PRs | same | Pull requests: write |
| Merge, enqueue to merge queue | same, write access | Contents: write, Pull requests: write |

Without Administration read, classic branch protection is reported as not visible (`protectionVisible: false`);
rulesets are still read and GitHub still enforces protection at merge time.

### Repository identity guard

Before any call Rail compares the registered owner/name/host with the configured `origin` URL
(`git config remote.origin.url`) and refuses mismatches with `POLICY_DENIED`. The client also verifies
`GET /repos/{owner}/{repo}` returns the same `full_name` and never follows repository redirects (a 301 for a renamed
or transferred repository is refused). Every request path is built from the verified coordinates, so a stale remote
cannot make Rail post to another repository.

## Synchronization (`rail sync`, `rail pr sync`)

`syncRepository` polls open PRs (and re-reads PRs Rail still believes are open), their files, reviews, check runs and
commit statuses, workflow runs, GraphQL review decision / merge state / merge-queue entry, branch rules for the
integration base, and merge outcomes. It records observed remote revisions as `github.pr_observed` / `pr.merged`
events.

- **Conditional requests:** GET responses carry ETags; the ETag is persisted in `sync_state` and the body in
  `<data>/cache/github/<repository>/`. Unchanged resources come back as `304` and do not count against the rate limit.
- **Rate limits:** primary (`x-ratelimit-remaining: 0` + `x-ratelimit-reset`) and secondary (`retry-after`, 429 or
  "secondary rate limit") limits raise `RATE_LIMITED` with `details.resetAt`; the client then fails fast until the
  reset and outbox operations are deferred until that time.
- **Transient errors:** idempotent reads retry with exponential backoff and jitter. Mutations are never retried
  blindly: a timeout, connection reset or 5xx after sending is `AMBIGUOUS_REMOTE_OUTCOME` and is reconciled by reading
  GitHub before any retry.
- **Offline:** a refused connection or DNS failure is `OFFLINE`. `sync_state.offline` is set, the last successful sync
  time is kept, queue ticks stop all remote mutations, `rail queue explain` reports `REMOTE_STATE_STALE` with the
  last-seen time, and local intents (queue requests, PR submissions) are stored. The next successful sync clears the
  flag; pending outbox operations then reconcile before replaying.
- **External edits (FR-GH-09):** GitHub state is adopted as is. A head change invalidates Rail reviews, candidates and
  queue validation for the PR. When Rail owns the branch (`expected_remote_head` set) an unexpected push or force push
  sets a blocking `external_divergence` until an operator acknowledges it; nothing is reverted. Force pushes are
  detected with the compare API. Merges outside Rail, closures, base retargeting, rule changes and dismissed approvals
  are recorded the same way.

## Eligibility (`rail queue explain`)

A PR is eligible only when every hard blocker is clear. Blockers are ordered and carry a machine code, a source and a
message:

| Source | Codes |
|---|---|
| github | `PR_NOT_OPEN`, `PR_DRAFT`, `RULES_UNKNOWN`, `MERGE_CONFLICT`, `MERGEABILITY_UNKNOWN`, `REQUIRED_CHECK_MISSING`, `REQUIRED_CHECK_PENDING`, `REQUIRED_CHECK_FAILED`, `CHECK_FAILED`, `CHANGES_REQUESTED`, `REVIEWS_REQUIRED`, `CODEOWNER_REVIEW_REQUIRED`, `BRANCH_BEHIND_BASE`, `MERGE_METHOD_NOT_ALLOWED`, `MERGE_QUEUE_REQUIRED`, `BLOCKED_BY_RULES`, `EXTERNAL_DIVERGENCE` |
| stack | `STACK_PARENT_NOT_MERGED` (soft: allowed inside a contiguous candidate), `STACK_PARENT_BLOCKED`, `DEPENDENCY_NOT_MERGED`, `DEPENDENCY_BLOCKED` |
| policy | `AUTONOMY_OBSERVE`, `HIGH_RISK_REVIEW_REQUIRED`, `APPROVAL_REQUIRED`, `OPERATOR_MERGE_APPROVAL_REQUIRED` |
| rail | `REVIEW_FINDINGS_OPEN` |
| queue / sync | `QUEUE_PAUSED`, `QUARANTINED`, `ESCALATED`, `REVISION_REQUIRED`, `RETRY_PENDING`, `NOT_SYNCED`, `REMOTE_STATE_STALE`, `RATE_LIMITED` |

Rules for stacked PRs are evaluated against the stack trunk, not the parent branch. Approvals for sensitive path
classes (`security.require_approval_for`) and for `assisted` autonomy (or `integration.auto_merge_eligible: false`)
are bound to the PR head: the approval subject is `<prId>@<headSha>`, so a new push always needs a new approval.
`observe` autonomy never merges.

## Queue modes

One queue exists per repository and integration base branch. With `integration.mode: auto` the mode is
**github-managed** when the branch rules contain a `merge_queue` rule and **rail-managed** otherwise; the mode only
switches while nothing is in flight. `requestIntegration` is idempotent: concurrent requests from several MCP hosts and
the CLI produce one active entry (`queue_entries_active` unique index inside `BEGIN IMMEDIATE`).

Ordering is deterministic: dependency correctness, eligibility, age promotion past
`scheduler.max_queue_age_minutes`, priority (higher first, 0–100), fewer failed attempts, unblock value, enqueue time,
entry id. Only the holder of the leadership lease `integration:<repositoryId>:<base>` executes merge side effects, and
it re-checks the lease generation before each external call.

### Mode A: GitHub merge queue

Preconditions: the base branch has "Require merge queue" (a `merge_queue` rule); every required workflow listens to
`merge_group` (Actions) or third-party CI builds `gh-readonly-queue/<base>/*` branches; the PR already passes the
PR-level required checks and reviews. Rail enqueues with the GraphQL `enqueuePullRequest` mutation (with
`expectedHeadOid`), then relies on GitHub's queue state and `merge_group` checks. A PR that leaves the queue without
merging is recorded as a failure for the retry policy. Ordinary auto-merge is never used for stacks.

### Mode B: Rail-managed

Candidates are serialized per base branch. A candidate records the base SHA, the ordered `(pr, head_sha)` list, the
synthesized tree/commit (`git merge-tree --write-tree` + `git commit-tree`, no working-tree checkout), policy revision,
rules fingerprint and CI evidence. Configured `validation.broad` commands run in a temporary detached worktree under
`dirs.worktrees/candidates/` and are stored as `validation_runs` bound to that commit, tree and environment
fingerprint. Before each merge Rail re-reads the base SHA, the PR head, the rules and the checks; any mismatch
invalidates the candidate and the new combination is validated before merging. Merges call
`PUT /pulls/{n}/merge` with the expected head `sha`. The candidate is `integration_validated` only when GitHub attests
the exact result (single PR, PR tree equals the integrated tree, required checks green); otherwise it is labelled
"not-yet-integration-validated" and GitHub's own rules still decide whether the merge is accepted.

Speculative grouping (`integration.speculative_validation`, capacity `scheduler.integration_capacity_per_branch > 1`)
only combines low/medium-risk PRs without dependencies and with disjoint files. Between merges of a group Rail
verifies the new base tree equals the candidate's intermediate tree.

### No proactive rebase

Rail never rebases or force-pushes a PR because the base advanced. A conflict found while synthesizing a candidate
blocks the entry with `REVISION_REQUIRED`, notifies the operator and calls `TaskHooks.onRevisionRequired`; the entry
is re-evaluated when the head changes. Strict "up to date" rules surface `BRANCH_BEHIND_BASE` instead of an automatic
update.

## Stacked pull requests

GitHub-native stacks (created with `gh stack submit`) expose a `stack` object (`id`, `position`, `size`, `base`) on
the REST pull request. GitHub merges stacks bottom-up as contiguous groups, rejects merging a mid-stack PR alone,
does not support auto-merge for stacks, and requires the asynchronous merge API
(`PUT /pulls/{n}/merge-async`, `merge_action: direct_merge | merge_queue`) instead of the classic merge endpoint.
Rail therefore:

- orders stack members by `position` and treats lower members as parents;
- validates a contiguous stack prefix as one candidate and merges it with one `merge-async` call on the top PR
  (Mode B, `direct_merge`) or enqueues it with `merge_action: merge_queue` (Mode A), polling
  `GET /pulls/{n}/merge-async/{uuid}` and confirming every PR is merged before recording success;
- blocks upper PRs with `STACK_PARENT_BLOCKED` when a lower PR fails, is quarantined or closed.

Without native stacks, a stack is modelled as a base-branch chain (PR B's base is PR A's head branch) or an explicit
dependency (`setPullRequestDependency`). Chain children are evaluated against the trunk's rules, integrated after (or
together with) their parent, and retargeted to the trunk with `PATCH /pulls/{n}` (`base`) before merging. Retargeting
changes the base only; it never rewrites history.

## Failure handling

Failures are fingerprinted per PR in `failure_records`. Transient classes (network, rate limit, CI infrastructure)
back off without counting. Deterministic failures retry up to `agents.max_retries_per_failure` (default 2) per
fingerprint, then the entry becomes `quarantined` (or `escalated` for policy, permission, authentication or
ambiguous outcomes) with a notification; other entries keep integrating. An operator retry (`updateQueueEntry` with `action: 'retry'`) resets the counter.

## Endpoints used

| Purpose | Endpoint | Docs |
|---|---|---|
| Repository identity | `GET /repos/{owner}/{repo}` | https://docs.github.com/en/rest/repos/repos#get-a-repository |
| List / get / create / update PRs | `GET,POST /repos/{o}/{r}/pulls`, `GET,PATCH /repos/{o}/{r}/pulls/{n}` | https://docs.github.com/en/rest/pulls/pulls |
| Files changed | `GET /repos/{o}/{r}/pulls/{n}/files` | https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files |
| Reviews | `GET /repos/{o}/{r}/pulls/{n}/reviews` | https://docs.github.com/en/rest/pulls/reviews |
| Merge (expected head `sha`) | `PUT /repos/{o}/{r}/pulls/{n}/merge` | https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request |
| Asynchronous / stack merge | `PUT /repos/{o}/{r}/pulls/{n}/merge-async`, `GET .../merge-async/{uuid}` | https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10 |
| Check runs | `GET /repos/{o}/{r}/commits/{sha}/check-runs` | https://docs.github.com/en/rest/checks/runs |
| Combined status | `GET /repos/{o}/{r}/commits/{sha}/status` | https://docs.github.com/en/rest/commits/statuses |
| Workflow runs | `GET /repos/{o}/{r}/actions/runs?head_sha=` | https://docs.github.com/en/rest/actions/workflow-runs |
| Branch head | `GET /repos/{o}/{r}/branches/{branch}` | https://docs.github.com/en/rest/branches/branches |
| Branch protection | `GET /repos/{o}/{r}/branches/{branch}/protection` | https://docs.github.com/en/rest/branches/branch-protection |
| Rules for a branch | `GET /repos/{o}/{r}/rules/branches/{branch}` | https://docs.github.com/en/rest/repos/rules |
| Force-push detection | `GET /repos/{o}/{r}/compare/{base}...{head}` | https://docs.github.com/en/rest/commits/commits#compare-two-commits |
| Review decision, merge state, queue entry | GraphQL `repository.pullRequest` | https://docs.github.com/en/graphql/reference/objects#pullrequest |
| Merge queue entries | GraphQL `repository.mergeQueue(branch)` | https://docs.github.com/en/graphql/reference/objects#mergequeue |
| Enqueue / dequeue | GraphQL `enqueuePullRequest`, `dequeuePullRequest` | https://docs.github.com/en/graphql/reference/mutations#enqueuepullrequest |

Background: [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
[merging stacked pull requests](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests).
Requests send `X-GitHub-Api-Version: 2026-03-10` (configurable through `GitHubClientOptions.apiVersion`).
