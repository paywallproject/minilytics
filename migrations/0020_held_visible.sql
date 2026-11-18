-- Time the held page has been visible (from the tracker's pings). Enough of it counts as a sign of a person.
ALTER TABLE held_visits ADD COLUMN visible INTEGER NOT NULL DEFAULT 0;
