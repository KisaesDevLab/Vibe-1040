/**
 * API + review UI server.
 *
 * Startup order matters and is the point (§11, P14):
 *   1. register task classes with the router and report what came back,
 *   2. assert US-region pinning — **fail closed**,
 *   3. only then start listening.
 *
 * An appliance that serves requests before step 2 has already lost the argument it was
 * built to win.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { registerAdminRoutes } from './api/admin-routes.ts';
import { registerRoutes } from './api/routes.ts';
import { attachUser } from './api/middleware.ts';
import { env } from './config/env.ts';
import { pool } from './db/client.ts';
import { closeQueues } from './queue/queues.ts';
import {
  assertUsRegionPinning,
  registerAndVerify,
  retryRegistrationInBackground,
  setRouterReachable,
} from './router/client.ts';
import { registry } from './schemas/registry.ts';

const here = dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    // A 300 DPI page inline as base64 is roughly 800 KB; a 60-page bundle upload is much
    // larger. This is the upload limit, not the router's.
    bodyLimit: 64 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(multipart, {
    limits: { fileSize: 64 * 1024 * 1024, files: 200 },
  });

  app.addHook('preHandler', attachUser);

  // Security headers. The review UI is same-origin only; page rasters must never be
  // embeddable or cacheable anywhere but the reviewer's tab.
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('Referrer-Policy', 'no-referrer');
    void reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  registerRoutes(app);
  registerAdminRoutes(app);

  const uiDir = join(here, '..', 'ui', 'dist');
  await app.register(staticFiles, { root: uiDir, prefix: '/', wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });

  return app;
}

async function main(): Promise<void> {
  const forms = await registry();
  console.log(`[startup] form schema registry loaded: ${forms.size} schemas across ${forms.years().join(', ')}`);

  /**
   * Registration failure is NOT fatal.
   *
   * §3: "There is no fallback path if the Router is unreachable — jobs park in a retry
   * queue and the UI says the Router is down." An unreachable router during a filing-season
   * restart must leave staff able to sign in, read completed bundles, and download
   * worksheets. Refusing to boot would turn a router blip into a total outage of work that
   * needs no inference at all.
   *
   * The region assertion below is a different matter and does fail closed.
   */
  try {
    const report = await registerAndVerify();
    setRouterReachable(true);
    for (const row of report.registered) {
      console.log(`[startup] task class ${row.key}: ${row.sensitivity}${row.created ? ' (created)' : ''}`);
    }
    for (const warning of report.warnings) {
      console.warn(`[startup] WARNING ${warning}`);
    }
  } catch (err) {
    setRouterReachable(false);
    console.error(
      `[startup] router unreachable — task classes are NOT registered: ${(err as Error).message}\n` +
        '          Serving in degraded mode: existing bundles are readable, new inference work parks.',
    );
    void retryRegistrationInBackground();
  }

  // Fails closed, and deliberately still does so even when the router is unreachable: an
  // app that cannot confirm US-region pinning must not process taxpayer data through it.
  // See QUESTIONS.md Q11 — the router has no region concept yet, so this refuses to start
  // unless ROUTER_REQUIRE_US_REGION=false in development.
  await assertUsRegionPinning();

  const app = await buildServer();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[startup] listening on ${env.PORT}`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await closeQueues();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

const isEntrypoint = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
