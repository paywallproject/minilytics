-- Cloudflare Turnstile check, run once per browser (measure-only for now: nothing is hidden because of it).
-- sessions.human: 1 = passed, 0 = failed, -1 = couldn't run (blocked, error, timeout), NULL = not checked.
ALTER TABLE sessions ADD COLUMN human INTEGER;
-- When this visitor last passed the check.
ALTER TABLE visitors ADD COLUMN human_at INTEGER;
