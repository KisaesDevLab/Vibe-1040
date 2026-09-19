-- Reverts 0011. Sessions born from SSO survive as ordinary rows with their OIDC identity
-- gone; identity links and the stored authentication settings (including the wrapped client
-- secret) are dropped, so SSO must be re-registered after a forward migration.

DROP INDEX IF EXISTS sessions_oidc_sid_idx;
DROP INDEX IF EXISTS sessions_oidc_identity_idx;

ALTER TABLE sessions
  DROP COLUMN IF EXISTS oidc_amr,
  DROP COLUMN IF EXISTS oidc_id_token,
  DROP COLUMN IF EXISTS oidc_sid,
  DROP COLUMN IF EXISTS oidc_subject,
  DROP COLUMN IF EXISTS oidc_issuer;

DROP TABLE IF EXISTS auth_revocations;
DROP TABLE IF EXISTS auth_settings;
DROP TABLE IF EXISTS auth_identities;
