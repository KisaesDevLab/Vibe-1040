import { defineConfig } from 'vitest/config';

/**
 * Test environment.
 *
 * `src/config/env.ts` parses at import and throws on a malformed environment — which is
 * the behaviour we want in production and which means tests must supply a valid one. These
 * are obvious throwaway values; nothing here reaches a real database, router, or key.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // One OpenTax wrapper for the whole run (P17). Three files need the engine reachable at
    // the single OPENTAX_URL the app reads, and vitest runs files in parallel.
    globalSetup: ['test/helpers/opentax-global.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://vibe1040:vibe1040@localhost:5432/vibe1040_test',
      REDIS_URL: 'redis://localhost:6379',
      VIBE_AI_ROUTER_URL: 'http://vibe-ai-router:8220',
      VIBE_AI_TOKEN: 'test-token-not-a-real-credential',
      ROUTER_REQUIRE_US_REGION: 'false',
      TIN_HASH_SALT: Buffer.alloc(32, 7).toString('base64'),
      SESSION_SECRET: Buffer.alloc(32, 8).toString('base64'),
      STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      STORAGE_LOCAL_PATH: './.test-blobs',
      // P17: the draft-return engine. A loopback port nothing listens on by default, so the
      // degraded path (engine absent) is what tests see unless a test starts the wrapper on it.
      DRAFT_RETURN_ENABLED: 'true',
      OPENTAX_URL: 'http://127.0.0.1:18238',
      OPENTAX_VERSION: '9.9.9-fake',
      OPENTAX_TIMEOUT_MS: '5000',
    },
  },
});
