-- Lets a reader who logs in later be linked to their earlier payments (e.g. automatic renewals) by email.
CREATE INDEX IF NOT EXISTS payments_email ON payments (site_id, email);
