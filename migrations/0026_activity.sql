-- How much a new visit's first pages were used, from the tracker's early pings (measuring only): act_events =
-- trusted mouse moves + scrolls + taps/clicks + keys (capped), act_secs = separate seconds with any of them.
-- Scripted crawlers send one mouse move; people reading send many, spread over time. NULL = not measured.
ALTER TABLE sessions ADD COLUMN act_events INTEGER;
ALTER TABLE sessions ADD COLUMN act_secs INTEGER;
ALTER TABLE held_visits ADD COLUMN act_events INTEGER;
ALTER TABLE held_visits ADD COLUMN act_secs INTEGER;
