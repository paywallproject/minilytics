-- Where each site's real readers are (visitors seen again on a later day, or logged in), and where all its visits
-- come from, over the last 14 days. Refreshed a few sites at a time by the hourly cron. A brand-new visitor from a
-- country outside a site's audience has to show more before it's counted (lib/hold.ts).
CREATE TABLE site_audience (
  site_id TEXT NOT NULL,
  country TEXT NOT NULL,
  readers INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, country)
);
CREATE TABLE audience_refresh (
  site_id TEXT PRIMARY KEY,
  refreshed_at INTEGER NOT NULL
);
