-- Held visits are kept for a week after they're decided, so we can check what the hold didn't count.
-- released_at: when a sign of a person turned it into a normal visit (NULL = not counted).
ALTER TABLE held_visits ADD COLUMN released_at INTEGER;
-- The first interaction (pointermove, scroll, pointerdown, keydown, touchstart) and how long after the page
-- started loading it came, to tell scripted interactions from people's.
ALTER TABLE held_visits ADD COLUMN engage_kind TEXT;
ALTER TABLE held_visits ADD COLUMN engage_ms INTEGER;
ALTER TABLE sessions ADD COLUMN engage_kind TEXT;
ALTER TABLE sessions ADD COLUMN engage_ms INTEGER;
CREATE INDEX held_visits_site_ts ON held_visits (site_id, ts);
-- Who it looked like at the time (browser, OS, device, place, network), for the admin check. JSON.
ALTER TABLE held_visits ADD COLUMN meta TEXT;
