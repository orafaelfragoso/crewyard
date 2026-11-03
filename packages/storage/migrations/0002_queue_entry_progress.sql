ALTER TABLE queue_entries ADD COLUMN progressing_since TEXT;
UPDATE queue_entries SET progressing_since = updated_at WHERE status IN ('waiting', 'eligible', 'candidate', 'validating', 'merging');
