-- History brought over from another analytics tool (Plausible CSV export). Those tools export daily totals,
-- not individual visits, so imported data lives apart from sessions/events and is added to the reports
-- only for days before Minilytics started collecting on the site.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- 'plausible'
  status TEXT NOT NULL,              -- 'importing' while rows are uploaded, then 'done'
  date_from TEXT NOT NULL,           -- YYYY-MM-DD, site time
  date_to TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX imports_site ON imports (site_id, created_at);

-- One row per day + dimension + value, e.g. (2025-03-05, 'source', 'Google', 12 visitors).
-- dim 'total' holds the site-wide daily numbers. duration is the sum of visit durations in seconds.
CREATE TABLE imported_stats (
  import_id TEXT NOT NULL,
  date TEXT NOT NULL,
  dim TEXT NOT NULL,
  label TEXT,
  extra TEXT,
  visitors INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX imported_stats_q ON imported_stats (import_id, dim, date);
