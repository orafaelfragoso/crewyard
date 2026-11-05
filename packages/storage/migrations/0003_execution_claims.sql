CREATE TABLE execution_claims (
  attempt_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  input_identity TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  process_host TEXT,
  process_pid INTEGER,
  process_start_identity TEXT,
  UNIQUE (scope, generation),
  CHECK (
    (process_host IS NULL AND process_pid IS NULL AND process_start_identity IS NULL)
    OR (process_host IS NOT NULL AND process_pid IS NOT NULL AND process_pid > 0 AND process_start_identity IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX execution_claims_active ON execution_claims(scope) WHERE released_at IS NULL;

CREATE TRIGGER execution_claims_immutable_identity
BEFORE UPDATE ON execution_claims
WHEN NEW.attempt_id != OLD.attempt_id OR NEW.scope != OLD.scope OR NEW.owner_id != OLD.owner_id
  OR NEW.generation != OLD.generation OR NEW.input_identity != OLD.input_identity
  OR NEW.acquired_at != OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'execution claim identity is immutable');
END;

CREATE TRIGGER execution_claims_immutable_process
BEFORE UPDATE ON execution_claims
WHEN OLD.process_pid IS NOT NULL AND (
  NEW.process_host IS NOT OLD.process_host OR NEW.process_pid IS NOT OLD.process_pid
  OR NEW.process_start_identity IS NOT OLD.process_start_identity
)
BEGIN
  SELECT RAISE(ABORT, 'execution process identity is immutable');
END;
