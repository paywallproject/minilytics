-- Email reports: who gets a performance summary for which site, and how often.
-- user_id 'admin' is the self-hosted admin (their email comes from ADMIN_EMAIL).
CREATE TABLE report_subscriptions (
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  frequency TEXT NOT NULL, -- 'weekly' | 'monthly'
  created_at INTEGER NOT NULL,
  -- First day (YYYY-MM-DD, site time) of the last period sent, so a period is never sent twice.
  last_period TEXT,
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX report_subscriptions_user ON report_subscriptions (user_id);
