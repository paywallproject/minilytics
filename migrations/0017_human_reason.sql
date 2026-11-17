-- Why the Turnstile check ended as it did: 'pass', a Turnstile error code (e.g. 600010), 'blocked' (script didn't
-- load), 'timeout', 'unsupported', 'render', a siteverify error code, or 'mismatch' (token made for another visit).
ALTER TABLE sessions ADD COLUMN human_reason TEXT;
