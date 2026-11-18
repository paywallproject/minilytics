-- A short hash of a new visit's browser setup (screen, pixel ratio, cores, memory, touch, languages, platform,
-- timezone, graphics renderer), from the tracker on a new visit's first page. Measuring only: residential-proxy
-- crawlers change IP and town every visit but run on a few identical machines, so one setup repeated across many
-- one-time visitors in far-apart towns marks a fleet. No personal data; real readers on the same phone model share it.
ALTER TABLE sessions ADD COLUMN fleet TEXT;
ALTER TABLE held_visits ADD COLUMN fleet TEXT;
