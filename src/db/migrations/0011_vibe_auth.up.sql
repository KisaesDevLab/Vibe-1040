-- 0011 — single sign-on through Vibe Auth (P16).
--
-- Three tables owned by @kisaesdevlab/vibe-auth, copied from that package's
-- sql/auth_identities.sql at 1.0.4 rather than executed from node_modules, so that this
-- repo's forward-and-back migration rule holds and a package upgrade cannot change the
-- schema behind a migration number that has already run. `user_id` is TEXT because that is
-- what the package's stores read and write; it holds a users.id uuid.
--
-- Plus the OIDC identity of a session, on the existing sessions row. An SSO sign-in ends in
-- the same row and the same cookie as a local one (no second session model); these columns
-- are what back-channel logout matches on and what RP-initiated logout needs as
-- id_token_hint. NULL oidc_issuer means the session was born from a local password.

CREATE TABLE IF NOT EXISTS auth_identities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email           TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_issuer_subject_uq UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

-- Settings -> Authentication values (mode, issuer, wrapped client secret, role map...).
CREATE TABLE IF NOT EXISTS auth_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Revocation list for stateless-JWT products. Inert here (sessions are server-side and
-- back-channel logout revokes the rows directly), but the package's stores expect it.
CREATE TABLE IF NOT EXISTS auth_revocations (
  subject_key    TEXT PRIMARY KEY,
  revoked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_until  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_revocations_until_idx ON auth_revocations (revoked_until);

ALTER TABLE sessions
  ADD COLUMN oidc_issuer   text,
  ADD COLUMN oidc_subject  text,
  ADD COLUMN oidc_sid      text,
  -- The raw ID token, sealed with STORAGE_ENCRYPTION_KEY (base64 of the blob envelope).
  -- Kept only so sign-out can hand it back to the IdP as id_token_hint.
  ADD COLUMN oidc_id_token text,
  -- What the IdP said about how the user authenticated. The evidence that the mandatory
  -- second factor ran (QUESTIONS.md Q18).
  ADD COLUMN oidc_amr      jsonb;

CREATE INDEX sessions_oidc_identity_idx ON sessions (oidc_issuer, oidc_subject) WHERE oidc_issuer IS NOT NULL;
CREATE INDEX sessions_oidc_sid_idx ON sessions (oidc_sid) WHERE oidc_sid IS NOT NULL;
