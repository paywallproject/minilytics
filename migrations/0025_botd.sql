-- Verdict of Fingerprint's open-source bot detector (BotD), run in the browser on a new visit's first page:
-- 'human', or the kind of automation it found ('headless_chrome', 'selenium', ...). NULL = didn't run (old tracker,
-- blocked, left first). Measuring only for now.
ALTER TABLE sessions ADD COLUMN botd TEXT;
ALTER TABLE held_visits ADD COLUMN botd TEXT;
