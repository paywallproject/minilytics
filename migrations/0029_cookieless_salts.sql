-- Daily random salts for cookieless visits (lib/cookieless.ts). Deleted after a day.
CREATE TABLE IF NOT EXISTS cookieless_salts (
  day TEXT PRIMARY KEY,
  salt TEXT NOT NULL
);
