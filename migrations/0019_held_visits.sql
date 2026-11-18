-- New Direct visits that look like proxy bots (browser timezone doesn't match the IP's, or a first page deep in an
-- archive) wait here instead of being counted. A sign of a person (interaction, login, a click out) turns one into
-- a normal visit; otherwise it's deleted after a few hours by the hourly cron.
CREATE TABLE held_visits (
  site_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  signals TEXT,
  reason TEXT NOT NULL,
  PRIMARY KEY (site_id, session_id)
);
CREATE INDEX held_visits_ts ON held_visits (ts);
-- Goals fired while held (e.g. "paywall shown" on load), recorded too if the visit is released. JSON array.
ALTER TABLE held_visits ADD COLUMN queued TEXT;
