/**
 * One OpenTax wrapper for the whole test run (P17).
 *
 * Three test files need the engine reachable at the single `OPENTAX_URL` the app reads from
 * its environment, and vitest runs files in parallel — so each file spawning its own wrapper
 * on that port raced, and one file's requests landed on another's process. A shared instance
 * started once is the fix, and it is also what a real deployment looks like: one sidecar,
 * many callers.
 *
 * The binary is `test/helpers/fake-opentax.mjs`. Nothing here exercises the real engine's
 * arithmetic; it exercises everything up to and including the process boundary.
 *
 * A test that needs the engine *absent* points `env.OPENTAX_URL` at a dead port for the
 * duration rather than stopping this one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Must match `OPENTAX_URL` in vitest.config.ts. */
export const OPENTAX_TEST_PORT = 18_238;
export const OPENTAX_TEST_URL = `http://127.0.0.1:${OPENTAX_TEST_PORT}`;

let child: ChildProcess | undefined;

export async function setup(): Promise<void> {
  child = spawn(process.execPath, [join(here, '..', '..', 'opentax', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(OPENTAX_TEST_PORT),
      OPENTAX_BIN: join(here, 'fake-opentax.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => {
    if (process.env['DEBUG_WRAPPER']) process.stderr.write(`[wrapper] ${d}`);
  });

  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`${OPENTAX_TEST_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the OpenTax test wrapper never became healthy at ${OPENTAX_TEST_URL}`);
}

export async function teardown(): Promise<void> {
  child?.kill('SIGKILL');
}
