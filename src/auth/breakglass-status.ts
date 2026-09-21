/**
 * Break-glass readiness, for a caller outside the app (P16).
 *
 *   docker exec vibe-1040 node dist/auth/breakglass-status.js
 *
 * Prints one line of JSON and nothing else on stdout:
 *
 *   {"exists":true,"active":true,"admin":true,"secondFactorEnrolled":false,"ready":false}
 *
 * `ready` is all four. The appliance console runs this (`sso.breakglassStatusCommand` in the
 * manifest) so it can say "break-glass NOT ready: authenticator not enrolled" instead of
 * inferring readiness from the fact that it once stored a password. The package's own
 * `breakglass status` cannot answer this: it knows nothing about this app's second factor.
 *
 * Read-only. No secret is read, let alone printed — see `breakglassStatus`.
 *
 * Exit status says whether the question was answered, not what the answer was: 0 with the
 * JSON above, including when `ready` is false; 1 when it could not be determined (no
 * database, bad environment), with the reason on stderr and nothing on stdout. A caller that
 * treated "not ready" as a crashed command would hide the one message this exists to deliver.
 */
import { pool } from '../db/client.ts';
import { breakglassStatus } from '../lib/vibeAuthUsers.ts';

breakglassStatus()
  .then((status) => {
    console.log(JSON.stringify(status));
    return pool.end();
  })
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(`breakglass-status: ${(err as Error).message}`);
    process.exit(1);
  });
