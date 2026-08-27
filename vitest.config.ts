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
    },
  },
});
