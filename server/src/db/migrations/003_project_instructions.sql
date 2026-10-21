-- =============================================================================
-- 003_project_instructions.sql
-- Per-project operator instructions / assistant persona.
--
-- An operator can give the assistant a role (for example "senior SQA engineer")
-- and an output convention (for example "deliverables as self-contained HTML")
-- for a specific project. These instructions are appended to the grounded answer
-- prompt for that project only. They are explicitly subordinate to the core
-- grounding, citation and untrusted-content rules, so they can never weaken
-- "answer only from evidence".
--
-- Optional: NULL means "no custom instructions".
-- =============================================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS instructions text;
