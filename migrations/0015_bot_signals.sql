-- Bot checks a visit failed (comma-separated, NULL when none), and whether the visitor ever interacted.
ALTER TABLE sessions ADD COLUMN signals TEXT;
ALTER TABLE sessions ADD COLUMN engaged INTEGER NOT NULL DEFAULT 0;
