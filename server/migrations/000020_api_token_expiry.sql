-- PR-D1 asked for API token expiry alongside revocation. Nullable, and NULL
-- means "never expires": rows minted before this point keep working, because
-- silently invalidating someone's existing automation would be the worse
-- default. Only a token created with an expiry can stop working on its own.
ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
