-- The held visit sent an interaction. Some crawlers fake one right before leaving, so it only counts together
-- with a few seconds on screen (see lib/hold.ts).
ALTER TABLE held_visits ADD COLUMN engaged INTEGER NOT NULL DEFAULT 0;
