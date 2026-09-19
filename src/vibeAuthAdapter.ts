/**
 * Adapter for the Vibe Auth break-glass CLI (P16).
 *
 *   node node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure|rotate|status --json
 *
 * The CLI finds this file through `"vibeAuth": { "adapter": … }` in package.json and runs it
 * inside the shipped image, which is how the appliance console provisions the emergency
 * account. It deliberately imports the user adapter and nothing from the HTTP server.
 *
 * The account this creates is a local admin with a password **and no second factor yet**.
 * It is not exempt from one (Q18): the first sign-in at /login/local runs authenticator
 * enrolment like any other new local user. Do that when the account is provisioned. An
 * authenticator that was never enrolled is discovered during the outage it was meant for.
 */
import { pool } from './db/client.ts';
import { ADMIN_ROLE, BREAKGLASS_EMAIL, vibeAuthAudit, vibeAuthUsers } from './lib/vibeAuthUsers.ts';

export default {
  users: vibeAuthUsers,
  audit: vibeAuthAudit,
  adminRole: ADMIN_ROLE,
  breakglassEmail: BREAKGLASS_EMAIL,
  close: () => pool.end(),
};
