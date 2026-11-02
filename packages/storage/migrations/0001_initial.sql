CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  name TEXT NOT NULL UNIQUE,
  config_path TEXT,
  autonomy TEXT NOT NULL DEFAULT 'guarded' CHECK (autonomy IN ('observe', 'assisted', 'guarded', 'autopilot')),
  intake_paused INTEGER NOT NULL DEFAULT 0,
  workers_paused INTEGER NOT NULL DEFAULT 0,
  policy_revision INTEGER NOT NULL DEFAULT 1,
  config_snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_path TEXT NOT NULL UNIQUE,
  remote_url TEXT,
  remote_host TEXT,
  remote_owner TEXT,
  remote_name TEXT,
  host_kind TEXT NOT NULL DEFAULT 'github',
  default_base TEXT NOT NULL,
  index_coverage TEXT,
  content_fingerprint TEXT,
  gh_config_dir TEXT,
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE repository_snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_sha TEXT NOT NULL,
  tree_sha TEXT,
  ref TEXT,
  parent_snapshot_id TEXT REFERENCES repository_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('building', 'available', 'failed', 'stale')),
  file_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  symbol_graph_revision TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  UNIQUE (repository_id, commit_sha)
) STRICT;

CREATE TABLE blobs (
  sha TEXT PRIMARY KEY,
  language TEXT,
  size INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'text', 'skipped', 'redacted', 'error')),
  parser TEXT,
  redactions INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
) STRICT;

CREATE TABLE files (
  snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha),
  language TEXT,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('source', 'test', 'doc', 'config', 'manifest', 'workflow', 'other')),
  package_root TEXT,
  PRIMARY KEY (snapshot_id, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX files_blob ON files(blob_sha);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  signature TEXT,
  container TEXT
) STRICT;
CREATE INDEX symbols_name ON symbols(name);
CREATE INDEX symbols_blob ON symbols(blob_sha);

CREATE TABLE symbol_edges (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('import', 'export', 'reference', 'call')),
  source_symbol TEXT,
  target TEXT NOT NULL,
  resolved_path TEXT,
  line INTEGER,
  resolution TEXT NOT NULL CHECK (resolution IN ('syntax', 'file', 'lsp', 'scip'))
) STRICT;
CREATE INDEX symbol_edges_blob ON symbol_edges(blob_sha);
CREATE INDEX symbol_edges_target ON symbol_edges(target);

CREATE VIRTUAL TABLE fts_entries USING fts5(
  content,
  blob_sha UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED,
  tokenize = "unicode61 tokenchars '_$'"
);

CREATE TABLE embeddings (
  blob_sha TEXT NOT NULL REFERENCES blobs(sha) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (blob_sha, start_line, model)
) STRICT;

CREATE TABLE context_artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('context_pack', 'impact_report', 'embedding_index')),
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES repository_snapshots(id) ON DELETE SET NULL,
  commit_sha TEXT,
  query TEXT,
  payload TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('draft', 'planning', 'awaiting_approval', 'approved', 'active', 'completed', 'cancelled')),
  plan TEXT,
  plan_errors TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_by TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('epic', 'task', 'subtask')),
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  repository_id TEXT REFERENCES repositories(id),
  base_branch TEXT,
  risk TEXT NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  priority INTEGER NOT NULL DEFAULT 50,
  priority_override INTEGER,
  scope_hints TEXT NOT NULL DEFAULT '[]',
  exclusive_resources TEXT NOT NULL DEFAULT '[]',
  permitted_tools TEXT,
  requested_role TEXT,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  budget TEXT,
  artifacts TEXT NOT NULL DEFAULT '{}',
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'issue', 'ai')),
  origin_ref TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  blocker_reason TEXT,
  handoff TEXT,
  assigned_agent_id TEXT,
  selected_profile_id TEXT,
  selected_model TEXT,
  routing_explanation TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL
) STRICT;
CREATE INDEX tasks_project_state ON tasks(project_id, state);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
) STRICT;
CREATE INDEX task_dependencies_reverse ON task_dependencies(depends_on_id);

CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('agent', 'session', 'operator')),
  holder_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  UNIQUE (task_id, generation)
) STRICT;
CREATE UNIQUE INDEX leases_one_active ON leases(task_id) WHERE released_at IS NULL;

CREATE TABLE task_scope_reservations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repository_id TEXT,
  project_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  scope TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('advisory', 'exclusive')),
  source TEXT NOT NULL CHECK (source IN ('impact', 'explicit', 'config')),
  created_at TEXT NOT NULL,
  released_at TEXT
) STRICT;
CREATE UNIQUE INDEX reservations_exclusive_active ON task_scope_reservations(project_id, scope)
  WHERE mode = 'exclusive' AND released_at IS NULL;
CREATE INDEX reservations_task ON task_scope_reservations(task_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'engineer',
  system_instructions TEXT,
  skills TEXT NOT NULL DEFAULT '[]',
  allowed_mcp_tools TEXT,
  provider_preferences TEXT NOT NULL DEFAULT '[]',
  account_policy_id TEXT,
  budget TEXT,
  fs_policy TEXT,
  network_policy TEXT NOT NULL DEFAULT 'provider-and-github-only',
  review_authority TEXT NOT NULL DEFAULT 'advisory' CHECK (review_authority IN ('none', 'advisory', 'required')),
  managed INTEGER NOT NULL DEFAULT 1,
  max_parallel INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_projects (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, project_id)
) STRICT;

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_team_memberships (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, team_id)
) STRICT;

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('codex', 'claude', 'opencode', 'generic', 'ollama')),
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  auth_mechanism TEXT NOT NULL CHECK (auth_mechanism IN ('cli-login', 'api-key', 'local', 'none')),
  auth_ref TEXT,
  config_root TEXT,
  permitted_models TEXT NOT NULL DEFAULT '[]',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, name)
) STRICT;

CREATE TABLE account_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  profile_ids TEXT NOT NULL,
  allow_fallback INTEGER NOT NULL DEFAULT 0,
  models TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE provider_health (
  profile_id TEXT PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'rate_limited', 'unavailable', 'unauthenticated', 'unknown')),
  detail TEXT,
  rate_limited_until TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_checked_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  path TEXT NOT NULL UNIQUE,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT,
  expected_remote_head TEXT,
  state TEXT NOT NULL CHECK (state IN ('allocating', 'ready', 'in_use', 'preserved', 'needs_reconciliation', 'cleaned')),
  cleanup_policy TEXT NOT NULL DEFAULT 'after_merge' CHECK (cleanup_policy IN ('after_merge', 'manual', 'retention')),
  bootstrap_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('backup_patch', 'backup_bundle', 'log', 'test_output', 'bootstrap_log')),
  path TEXT NOT NULL,
  sha256 TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES provider_profiles(id) ON DELETE SET NULL,
  provider_id TEXT NOT NULL,
  model TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  lease_generation INTEGER,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  managed INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL DEFAULT 'execute' CHECK (mode IN ('execute', 'plan', 'review')),
  pid INTEGER,
  host TEXT,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'orphaned', 'lost')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_heartbeat_at TEXT,
  checkpoint TEXT,
  log_path TEXT,
  exit_code INTEGER,
  outcome TEXT,
  error_reason TEXT,
  session_token_hash TEXT,
  provider_session_id TEXT
) STRICT;
CREATE INDEX sessions_state ON sessions(state);

CREATE TABLE session_events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (session_id, seq)
) STRICT;

CREATE TABLE session_usage (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  profile_id TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  usage_source TEXT NOT NULL CHECK (usage_source IN ('measured', 'estimated', 'unknown')),
  cost_source TEXT NOT NULL CHECK (cost_source IN ('reported', 'configured_rate', 'unknown')),
  at TEXT NOT NULL
) STRICT;

CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT,
  expected_remote_head TEXT,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  is_draft INTEGER NOT NULL DEFAULT 0,
  mergeable TEXT,
  merge_state_status TEXT,
  review_decision TEXT,
  checks_state TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  reviews TEXT NOT NULL DEFAULT '[]',
  rules TEXT,
  changed_files TEXT,
  merge_commit_sha TEXT,
  merged_at TEXT,
  stack_id TEXT,
  stack_order INTEGER,
  imported INTEGER NOT NULL DEFAULT 0,
  external_divergence TEXT,
  remote_updated_at TEXT,
  etag TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, number)
) STRICT;

CREATE TABLE pr_dependencies (
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  depends_on_pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('stack_parent', 'task_dependency')),
  PRIMARY KEY (pr_id, depends_on_pr_id)
) STRICT;

CREATE TABLE review_artifacts (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  review_type TEXT NOT NULL CHECK (review_type IN ('code', 'security', 'integration')),
  fingerprint TEXT NOT NULL,
  fingerprint_inputs TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  base_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'changes_requested', 'failed', 'invalidated')),
  reviewer_identity TEXT NOT NULL,
  reviewer_model TEXT,
  policy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  security_class TEXT NOT NULL,
  scope TEXT,
  confidence REAL,
  llm_invoked INTEGER NOT NULL DEFAULT 0,
  reused_from TEXT REFERENCES review_artifacts(id),
  invalidated_reason TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX review_artifacts_fingerprint ON review_artifacts(review_type, fingerprint);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES review_artifacts(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  confidence REAL NOT NULL,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  reason TEXT NOT NULL,
  evidence TEXT,
  suggested_fix TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'resolved')),
  reviewer_identity TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (review_id, signature)
) STRICT;

CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id TEXT REFERENCES pull_requests(id) ON DELETE SET NULL,
  candidate_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('fast', 'broad', 'required')),
  commands TEXT NOT NULL,
  env_fingerprint TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_sha TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'passed', 'failed', 'error')),
  exit_code INTEGER,
  duration_ms INTEGER,
  output_ref TEXT,
  failure_fingerprint TEXT,
  failure_class TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE failure_records (
  fingerprint TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('task', 'pr', 'candidate', 'outbox')),
  subject_id TEXT NOT NULL,
  failure_class TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_evidence TEXT,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (fingerprint, subject_kind, subject_id)
) STRICT;

CREATE TABLE integration_queues (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  base_branch TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('github-managed', 'rail-managed')),
  paused INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repository_id, base_branch)
) STRICT;

CREATE TABLE queue_entries (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES integration_queues(id) ON DELETE CASCADE,
  pr_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 50,
  risk TEXT NOT NULL DEFAULT 'medium',
  stack_id TEXT,
  stack_order INTEGER,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'eligible', 'candidate', 'validating', 'merging', 'merged', 'blocked', 'quarantined', 'escalated', 'removed')),
  blockers TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_validated_base_sha TEXT,
  last_validated_head_sha TEXT,
  requested_by TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX queue_entries_active ON queue_entries(queue_id, pr_id) WHERE status NOT IN ('merged', 'removed');

CREATE TABLE integration_candidates (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL REFERENCES integration_queues(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  entries TEXT NOT NULL,
  tree_sha TEXT,
  commit_sha TEXT,
  policy_revision INTEGER NOT NULL,
  rules_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'validating', 'valid', 'invalid', 'merged', 'failed')),
  ci_evidence TEXT NOT NULL DEFAULT '{}',
  integration_validated INTEGER NOT NULL DEFAULT 0,
  invalid_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
) STRICT;

CREATE TABLE worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('service', 'mcp', 'cli', 'dashboard')),
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  status TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
) STRICT;

CREATE TABLE service_leadership (
  scope TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE outbox (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  subject_id TEXT,
  intent TEXT NOT NULL,
  expected_state TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending', 'attempted', 'succeeded', 'failed', 'ambiguous', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  remote_correlation TEXT,
  leader_generation INTEGER,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE remote_operations (
  id TEXT PRIMARY KEY,
  operation_id TEXT REFERENCES outbox(operation_id) ON DELETE SET NULL,
  host TEXT NOT NULL,
  method TEXT NOT NULL,
  target TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_status INTEGER,
  remote_id TEXT,
  result TEXT,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  session_id TEXT,
  pr_id TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
) STRICT;
CREATE INDEX events_project ON events(project_id, seq);
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_type ON events(type, seq);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER REFERENCES events(seq),
  operator TEXT,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  agent_id TEXT,
  profile_ref TEXT,
  project_id TEXT,
  task_id TEXT,
  policy_revision INTEGER,
  action TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  remote_result TEXT,
  at TEXT NOT NULL
) STRICT;

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'agent', 'profile', 'task')),
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'month', 'total')),
  token_limit INTEGER,
  cost_limit_usd REAL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_kind, scope_id, period)
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
) STRICT;

CREATE TABLE policy_revisions (
  policy_id TEXT NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  body_fingerprint TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, revision)
) STRICT;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('goal_plan', 'task', 'pr_publish', 'merge', 'repo_hooks', 'cleanup')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX approvals_pending ON approvals(subject_kind, subject_id) WHERE status = 'pending';

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error', 'action_required')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  pr_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
) STRICT;

CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  offline INTEGER NOT NULL DEFAULT 0,
  rate_limit_reset_at TEXT
) STRICT;
