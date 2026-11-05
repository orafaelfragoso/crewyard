CREATE TRIGGER writer_guard_schema_migrations_insert BEFORE INSERT ON schema_migrations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_schema_migrations_update BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_schema_migrations_delete BEFORE DELETE ON schema_migrations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_organizations_insert BEFORE INSERT ON organizations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_organizations_update BEFORE UPDATE ON organizations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_organizations_delete BEFORE DELETE ON organizations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sequences_insert BEFORE INSERT ON sequences
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sequences_update BEFORE UPDATE ON sequences
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sequences_delete BEFORE DELETE ON sequences
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_projects_insert BEFORE INSERT ON projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_projects_update BEFORE UPDATE ON projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_projects_delete BEFORE DELETE ON projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repositories_insert BEFORE INSERT ON repositories
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repositories_update BEFORE UPDATE ON repositories
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repositories_delete BEFORE DELETE ON repositories
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repository_snapshots_insert BEFORE INSERT ON repository_snapshots
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repository_snapshots_update BEFORE UPDATE ON repository_snapshots
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_repository_snapshots_delete BEFORE DELETE ON repository_snapshots
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_blobs_insert BEFORE INSERT ON blobs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_blobs_update BEFORE UPDATE ON blobs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_blobs_delete BEFORE DELETE ON blobs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_files_insert BEFORE INSERT ON files
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_files_update BEFORE UPDATE ON files
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_files_delete BEFORE DELETE ON files
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbols_insert BEFORE INSERT ON symbols
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbols_update BEFORE UPDATE ON symbols
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbols_delete BEFORE DELETE ON symbols
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbol_edges_insert BEFORE INSERT ON symbol_edges
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbol_edges_update BEFORE UPDATE ON symbol_edges
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_symbol_edges_delete BEFORE DELETE ON symbol_edges
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_embeddings_insert BEFORE INSERT ON embeddings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_embeddings_update BEFORE UPDATE ON embeddings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_embeddings_delete BEFORE DELETE ON embeddings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_context_artifacts_insert BEFORE INSERT ON context_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_context_artifacts_update BEFORE UPDATE ON context_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_context_artifacts_delete BEFORE DELETE ON context_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_goals_insert BEFORE INSERT ON goals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_goals_update BEFORE UPDATE ON goals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_goals_delete BEFORE DELETE ON goals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_tasks_insert BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_tasks_update BEFORE UPDATE ON tasks
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_tasks_delete BEFORE DELETE ON tasks
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_dependencies_insert BEFORE INSERT ON task_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_dependencies_update BEFORE UPDATE ON task_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_dependencies_delete BEFORE DELETE ON task_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_leases_insert BEFORE INSERT ON leases
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_leases_update BEFORE UPDATE ON leases
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_leases_delete BEFORE DELETE ON leases
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_scope_reservations_insert BEFORE INSERT ON task_scope_reservations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_scope_reservations_update BEFORE UPDATE ON task_scope_reservations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_task_scope_reservations_delete BEFORE DELETE ON task_scope_reservations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agents_insert BEFORE INSERT ON agents
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agents_update BEFORE UPDATE ON agents
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agents_delete BEFORE DELETE ON agents
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_projects_insert BEFORE INSERT ON agent_projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_projects_update BEFORE UPDATE ON agent_projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_projects_delete BEFORE DELETE ON agent_projects
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_teams_insert BEFORE INSERT ON teams
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_teams_update BEFORE UPDATE ON teams
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_teams_delete BEFORE DELETE ON teams
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_team_memberships_insert BEFORE INSERT ON agent_team_memberships
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_team_memberships_update BEFORE UPDATE ON agent_team_memberships
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_agent_team_memberships_delete BEFORE DELETE ON agent_team_memberships
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_profiles_insert BEFORE INSERT ON provider_profiles
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_profiles_update BEFORE UPDATE ON provider_profiles
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_profiles_delete BEFORE DELETE ON provider_profiles
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_account_policies_insert BEFORE INSERT ON account_policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_account_policies_update BEFORE UPDATE ON account_policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_account_policies_delete BEFORE DELETE ON account_policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_health_insert BEFORE INSERT ON provider_health
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_health_update BEFORE UPDATE ON provider_health
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_provider_health_delete BEFORE DELETE ON provider_health
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspaces_insert BEFORE INSERT ON workspaces
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspaces_update BEFORE UPDATE ON workspaces
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspaces_delete BEFORE DELETE ON workspaces
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspace_artifacts_insert BEFORE INSERT ON workspace_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspace_artifacts_update BEFORE UPDATE ON workspace_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_workspace_artifacts_delete BEFORE DELETE ON workspace_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sessions_insert BEFORE INSERT ON sessions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sessions_update BEFORE UPDATE ON sessions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sessions_delete BEFORE DELETE ON sessions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_events_insert BEFORE INSERT ON session_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_events_update BEFORE UPDATE ON session_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_events_delete BEFORE DELETE ON session_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_usage_insert BEFORE INSERT ON session_usage
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_usage_update BEFORE UPDATE ON session_usage
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_session_usage_delete BEFORE DELETE ON session_usage
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pull_requests_insert BEFORE INSERT ON pull_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pull_requests_update BEFORE UPDATE ON pull_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pull_requests_delete BEFORE DELETE ON pull_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pr_dependencies_insert BEFORE INSERT ON pr_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pr_dependencies_update BEFORE UPDATE ON pr_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_pr_dependencies_delete BEFORE DELETE ON pr_dependencies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_artifacts_insert BEFORE INSERT ON review_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_artifacts_update BEFORE UPDATE ON review_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_artifacts_delete BEFORE DELETE ON review_artifacts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_findings_insert BEFORE INSERT ON review_findings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_findings_update BEFORE UPDATE ON review_findings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_findings_delete BEFORE DELETE ON review_findings
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_validation_runs_insert BEFORE INSERT ON validation_runs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_validation_runs_update BEFORE UPDATE ON validation_runs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_validation_runs_delete BEFORE DELETE ON validation_runs
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_failure_records_insert BEFORE INSERT ON failure_records
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_failure_records_update BEFORE UPDATE ON failure_records
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_failure_records_delete BEFORE DELETE ON failure_records
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_queues_insert BEFORE INSERT ON integration_queues
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_queues_update BEFORE UPDATE ON integration_queues
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_queues_delete BEFORE DELETE ON integration_queues
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_queue_entries_insert BEFORE INSERT ON queue_entries
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_queue_entries_update BEFORE UPDATE ON queue_entries
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_queue_entries_delete BEFORE DELETE ON queue_entries
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_candidates_insert BEFORE INSERT ON integration_candidates
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_candidates_update BEFORE UPDATE ON integration_candidates
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_integration_candidates_delete BEFORE DELETE ON integration_candidates
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_worker_heartbeats_insert BEFORE INSERT ON worker_heartbeats
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_worker_heartbeats_update BEFORE UPDATE ON worker_heartbeats
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_worker_heartbeats_delete BEFORE DELETE ON worker_heartbeats
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_service_leadership_insert BEFORE INSERT ON service_leadership
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_service_leadership_update BEFORE UPDATE ON service_leadership
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_service_leadership_delete BEFORE DELETE ON service_leadership
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_outbox_insert BEFORE INSERT ON outbox
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_outbox_update BEFORE UPDATE ON outbox
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_outbox_delete BEFORE DELETE ON outbox
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_remote_operations_insert BEFORE INSERT ON remote_operations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_remote_operations_update BEFORE UPDATE ON remote_operations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_remote_operations_delete BEFORE DELETE ON remote_operations
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_events_insert BEFORE INSERT ON events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_events_update BEFORE UPDATE ON events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_events_delete BEFORE DELETE ON events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_audit_events_insert BEFORE INSERT ON audit_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_audit_events_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_audit_events_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_budgets_insert BEFORE INSERT ON budgets
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_budgets_update BEFORE UPDATE ON budgets
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_budgets_delete BEFORE DELETE ON budgets
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policies_insert BEFORE INSERT ON policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policies_update BEFORE UPDATE ON policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policies_delete BEFORE DELETE ON policies
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policy_revisions_insert BEFORE INSERT ON policy_revisions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policy_revisions_update BEFORE UPDATE ON policy_revisions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_policy_revisions_delete BEFORE DELETE ON policy_revisions
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_approvals_insert BEFORE INSERT ON approvals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_approvals_update BEFORE UPDATE ON approvals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_approvals_delete BEFORE DELETE ON approvals
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_notifications_insert BEFORE INSERT ON notifications
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_notifications_update BEFORE UPDATE ON notifications
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_notifications_delete BEFORE DELETE ON notifications
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sync_state_insert BEFORE INSERT ON sync_state
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sync_state_update BEFORE UPDATE ON sync_state
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_sync_state_delete BEFORE DELETE ON sync_state
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_execution_claims_insert BEFORE INSERT ON execution_claims
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_execution_claims_update BEFORE UPDATE ON execution_claims
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_execution_claims_delete BEFORE DELETE ON execution_claims
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_attempts_insert BEFORE INSERT ON review_attempts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_attempts_update BEFORE UPDATE ON review_attempts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_attempts_delete BEFORE DELETE ON review_attempts
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_requests_insert BEFORE INSERT ON review_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_requests_update BEFORE UPDATE ON review_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

CREATE TRIGGER writer_guard_review_requests_delete BEFORE DELETE ON review_requests
BEGIN
  SELECT CASE WHEN crewyard_writer_protocol() <> 1 THEN RAISE(ABORT, 'Incompatible Crewyard writer; stop old processes and upgrade') END;
END;

