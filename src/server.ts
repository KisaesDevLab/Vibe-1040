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
import { formatFindings } from './draft/catalog.ts';
import { engineReadiness } from './draft/generate.ts';
import { registerVibeAuth, vibeAuth } from './lib/vibeAuth.ts';
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

  // Single sign-on (P16): /auth/*. After the cookie plugin, because the session adapter sets
  // the same cookie a local sign-in does; before the app's routes, per Vibe Auth's mounting
  // rule. `attachUser` runs on these routes too and is harmless — it only reads.
  await registerVibeAuth(app);

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
    // /auth/ is the OIDC surface. A mistyped callback path must be a 404, not the SPA shell —
    // an identity provider handed `index.html` with a 200 reports success for a failure.
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/')) {
      return reply.code(404).send({ error: 'not found' });
    }
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

  // Say out loud which way the session cookie resolved, every boot. A `Secure` cookie on a
  // plain-HTTP origin locks every staff account out of an app that looks healthy, and the
  // reverse is a quiet weakening of §11's in-transit control. Neither is something an
  // operator should have to read an env file to discover.
  if (env.OCR_FALLBACK_ENABLED) {
    console.log(
      '[startup] OCR fallback: ENABLED — pages with no text layer are transcribed through ' +
        'v1040_ocr_transcribe. Whether that stays on the appliance depends on what a firm ' +
        'admin bound the class to; the task-class line above reports how it resolved.',
    );
  }

  if (env.SESSION_SECURE) {
    console.log('[startup] session cookie: Secure — sign-in requires an HTTPS origin');
  } else {
    console.warn(
      '[startup] WARNING session cookie: NOT Secure (SESSION_SECURE=false) — staff ' +
        'credentials and worksheets cross this network in cleartext. Correct for a ' +
        'plain-HTTP LAN or Tailscale origin; wrong for anything public.',
    );
  }

  // Single sign-on. Discovery failure is not fatal — an unreachable identity provider leaves
  // local sign-in working and the engine retries in the background. The one thing that does
  // throw, and should, is `oidc_only` with no usable break-glass account: that combination
  // locks every administrator out the first time the IdP is down.
  await vibeAuth.start();
  const sso = vibeAuth.status();
  // Says nothing about whether the identity provider answered: `start()` begins discovery in
  // the background and returns, so at this point it never has. The engine logs the outcome
  // itself ("identity provider discovered", or an `idp.unreachable` audit row), and
  // /auth/status reports it live.
  console.log(
    `[startup] sign-in mode: ${sso.mode}` +
      (sso.oidc.enabled
        ? ` — single sign-on via ${sso.oidc.idpName} at ${sso.oidc.issuer ?? '(issuer unset)'}; ` +
          'SSO sessions require proof of a second factor (amr), which cannot be disabled here'
        : ' — single sign-on off'),
  );

  const app = await buildServer();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[startup] listening on ${env.PORT}`);

  /**
   * Does the node map still match the engine it is pointed at? (P17, §14.)
   *
   * **After listening, and never fatal.** It spawns a child process per node type, so it must
   * not sit in front of the port; and an optional checking aid may not take the appliance down
   * with it — the precedent is router-down parking (§3). A mismatch withholds draft returns,
   * which `generateDraftReturn` enforces on its own; the worksheet is untouched either way.
   *
   * It is said out loud at boot because the failure it catches is otherwise invisible: an
   * engine field renamed between releases is accepted and ignored when it is optional, so the
   * amount vanishes and the line reads as absent. Nobody goes looking for a number that is not
   * there.
   */
  if (env.DRAFT_RETURN_ENABLED) {
    void (async () => {
      try {
        const readiness = await engineReadiness();
        if (!readiness.engine.ok) {
          console.warn(
            `[startup] draft return: engine unreachable at ${env.OPENTAX_URL} ` +
              `(${readiness.engine.reason ?? 'no reason given'}). Draft returns park; nothing else is affected.`,
          );
          return;
        }
        if (!readiness.versionsAgree) {
          console.warn(
            `[startup] WARNING draft return: engine reports ${readiness.engine.version}, ` +
              `OPENTAX_VERSION pins ${readiness.pins.environment}, node map ` +
              `${readiness.pins.nodeMapVersion} was written against ${readiness.pins.nodeMap}. ` +
              'See docs/opentax-draft-return.md, "Upgrading the engine".',
          );
        }
        const check = readiness.check;
        if (!check) return;
        if (check.ok && check.findings.length === 0) {
          console.log(
            `[startup] draft return: engine ${check.engineVersion}, node map agrees on all ` +
              `${check.nodeTypes.length} node types`,
          );
          return;
        }
        console.warn(
          `[startup] WARNING draft return: the node map does not match engine ` +
            `${check.engineVersion} — ${check.blocking.length} blocking, ` +
            `${check.findings.length - check.blocking.length} advisory. ` +
            (check.ok
              ? 'Draft returns still compute.'
              : 'DRAFT RETURNS ARE WITHHELD until this is resolved; the worksheet is unaffected.'),
        );
        for (const line of formatFindings(check)) console.warn(`          ${line}`);
      } catch (err) {
        console.warn(
          `[startup] draft return: could not read the engine's node catalogue: ${(err as Error).message}`,
        );
      }
    })();
  }

  const shutdown = async (): Promise<void> => {
    vibeAuth.stop();
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
