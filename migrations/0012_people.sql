-- More people per site. The owner (sites.owner_id) stays the owner; these are the extra logins.
-- role 'viewer' = the dashboard only; 'manager' = the dashboard and settings, but can't delete the site.
CREATE TABLE site_members (
  site_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (site_id, user_id)
);
CREATE INDEX site_members_user ON site_members (user_id);

-- Self-hosted: 1 = a teammate of the admin. Staff see and manage every site, like the admin.
ALTER TABLE users ADD COLUMN staff INTEGER NOT NULL DEFAULT 0;
