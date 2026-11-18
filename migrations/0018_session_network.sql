-- The network (ASN and its owner) each visit came from, e.g. "AS14618 Amazon.com, Inc.". Used to spot hosting
-- networks that should be on the data-center list. NULL when the script is proxied (we'd only see the proxy).
ALTER TABLE sessions ADD COLUMN network TEXT;
