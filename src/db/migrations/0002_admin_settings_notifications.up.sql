-- 0002 — firm settings, notification channels, and email/SMS second factors.
--
-- Firm-policy values move out of the environment and into the database so a firm admin can
-- change them without shell access and every change is audited. Secrets and infrastructure
-- stay in the environment (§11) — a web form is the wrong place for a decryption key.

CREATE TYPE mfa_method AS ENUM ('totp', 'email', 'sms');
CREATE TYPE otp_purpose AS ENUM ('mfa', 'password_reset', 'phone_verify');

CREATE TABLE firm_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  /** True when `value` holds a sealed secret rather than plaintext (see src/storage). */
  is_secret   boolean NOT NULL DEFAULT false,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Second-factor and reset delivery.
ALTER TABLE users ADD COLUMN phone text;
ALTER TABLE users ADD COLUMN phone_verified_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_method mfa_method NOT NULL DEFAULT 'totp';
-- MFA stays mandatory (§11). This records WHICH factor a user completed, never whether to
-- require one.
ALTER TABLE users ADD COLUMN mfa_enrolled_at timestamptz;

/**
 * One-time codes for email/SMS second factors and password resets.
 *
 * The code itself is never stored — only a salted hash, exactly like a session token. A
 * database read must not let anyone complete a second factor or reset a password.
 */
CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      otp_purpose NOT NULL,
  code_hash    text NOT NULL,
  /** Where it was sent, redacted for display: "j***@example.com" or "***-***-1234". */
  destination  text NOT NULL,
  channel      mfa_method NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_user_purpose_idx ON otp_challenges(user_id, purpose);
CREATE INDEX otp_expires_idx ON otp_challenges(expires_at);

/**
 * Delivery attempts. A second factor that silently fails to send is indistinguishable from
 * a user ignoring it, and during filing season that difference matters.
 */
CREATE TABLE notification_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  user_id     uuid REFERENCES users(id),
  channel     mfa_method NOT NULL,
  purpose     otp_purpose NOT NULL,
  destination text NOT NULL,
  succeeded   boolean NOT NULL,
  error       text
);
CREATE INDEX notification_log_at_idx ON notification_log(at);
