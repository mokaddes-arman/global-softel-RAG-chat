-- =============================================================================
-- 004_model_usage.sql
-- Indexes for the per-model usage reporting page (/model-usage).
--
-- Usage is derived entirely from assistant messages that completed: each one
-- records the concrete `model` and its `token_usage`. Two partial indexes keep
-- the "group by model over a date range" aggregations fast without touching the
-- much larger set of user messages.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_messages_usage_model
  ON messages (model, created_at)
  WHERE role = 'assistant';

CREATE INDEX IF NOT EXISTS idx_messages_usage_created
  ON messages (created_at)
  WHERE role = 'assistant';
