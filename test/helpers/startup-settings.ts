/**
 * Seed the boot snapshot for every test file.
 *
 * `src/settings/runtime.ts` captures two settings once at startup, because they decide which
 * task classes get registered with the router and a live read would let the app call a class
 * this process never declared. It throws rather than guessing when it was never loaded — which
 * is the right behaviour, and which means the suite has to do what a real entry point does.
 *
 * Seeded from the environment rather than the database on purpose: that is exactly what
 * `loadStartupSettings()` produces when no firm has overridden them, it is the deployment
 * default, and it needs no Postgres — so the files that skip themselves without a database still
 * exercise the same path. A test that wants the other value calls `__setStartupSettings`.
 */
import { env } from '../../src/config/env.ts';
import { __setStartupSettings } from '../../src/settings/runtime.ts';

__setStartupSettings({
  attachPageImage: env.EXTRACT_ATTACH_PAGE_IMAGE,
  ocrFallbackEnabled: env.OCR_FALLBACK_ENABLED,
});
