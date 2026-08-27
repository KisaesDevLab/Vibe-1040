/** Retention entrypoint. Run on a schedule by the operator (no auto-update timers). */
import { pool } from '../db/client.ts';
import { runRetention } from './purge.ts';

runRetention()
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    return pool.end();
  })
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
