-- 0002 rollback.

DROP TABLE IF EXISTS notification_log;
DROP TABLE IF EXISTS otp_challenges;
DROP TABLE IF EXISTS firm_settings;

ALTER TABLE users DROP COLUMN IF EXISTS mfa_enrolled_at;
ALTER TABLE users DROP COLUMN IF EXISTS mfa_method;
ALTER TABLE users DROP COLUMN IF EXISTS phone_verified_at;
ALTER TABLE users DROP COLUMN IF EXISTS phone;

DROP TYPE IF EXISTS otp_purpose;
DROP TYPE IF EXISTS mfa_method;
