CREATE TABLE review_attempts (
  id TEXT PRIMARY KEY REFERENCES execution_claims(attempt_id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  fingerprint TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental')),
  review_id TEXT NOT NULL UNIQUE REFERENCES review_artifacts(id),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE review_requests (
  id TEXT PRIMARY KEY,
  attempt_id TEXT REFERENCES review_attempts(id),
  review_id TEXT NOT NULL UNIQUE REFERENCES review_artifacts(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  pr_id TEXT REFERENCES pull_requests(id),
  task_id TEXT REFERENCES tasks(id),
  fingerprint TEXT NOT NULL,
  force INTEGER NOT NULL CHECK (force IN (0, 1)),
  process_host TEXT NOT NULL,
  process_pid INTEGER NOT NULL,
  process_start_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'completed', 'failed', 'interrupted')),
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX review_requests_attempt ON review_requests(attempt_id, status);
CREATE INDEX review_attempts_fingerprint ON review_attempts(fingerprint, status);
