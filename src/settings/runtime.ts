/**
 * The settings that are only safe to read once, at boot.
 *
 * Most settings are read live: an admin widens the rounding tolerance and the next
 * reconciliation uses it. Two cannot be, and the reason is not caution — it is that they decide
 * *what task classes get registered with the router at startup*:
 *
 *  - `extraction.attach_page_image` decides whether `v1040_field_extract` is registered as a
 *    vision class.
 *  - `extraction.ocr_fallback_enabled` decides whether `v1040_ocr_transcribe` is registered
 *    at all.
 *
 * Read those live and the app tears itself in half: OCR fallback switches on at 11am, the
 * transcribe path starts calling a class this process never registered, and every scanned page
 * fails with `capability_missing` — which §3 says is an app bug that must log loudly, and it
 * would be right. So the value is captured once, every read site uses the snapshot, and the
 * admin UI says the change is pending until the API and worker restart.
 *
 * That honesty is the whole point. A switch that moves, saves, and changes nothing is the same
 * defect as the filing-status control that rendered dead for a week — and a snapshot plus a
 * visible "pending restart" badge is the version of this feature that cannot lie.
 */
import { setting } from './store.ts';

export interface StartupSettings {
  attachPageImage: boolean;
  ocrFallbackEnabled: boolean;
}

let snapshot: StartupSettings | null = null;

/**
 * Called once from each entry point — the API server and the queue worker — before anything
 * registers a task class or processes a job.
 *
 * Both, not just the API: the worker is the process that actually runs extraction, so a worker
 * booting from a stale view of these would attach page images the API never registered a vision
 * class for. They read the same rows, so they agree as long as both are restarted, which is
 * exactly what the UI tells an admin to do.
 */
export async function loadStartupSettings(): Promise<StartupSettings> {
  snapshot = {
    attachPageImage: await setting<boolean>('extraction.attach_page_image'),
    ocrFallbackEnabled: await setting<boolean>('extraction.ocr_fallback_enabled'),
  };
  return snapshot;
}

/**
 * The boot snapshot, for the synchronous read sites.
 *
 * Throws rather than falling back to the environment if boot never loaded it. A silent fallback
 * would mean a code path that works in the API and quietly behaves differently in the worker,
 * or in a test, depending on which one remembered to initialise — and "behaves differently
 * depending on who asked" is the failure this module exists to prevent, not one to reintroduce
 * in its own error handling.
 */
export function startupSettings(): StartupSettings {
  if (!snapshot) {
    throw new Error(
      'startup settings were read before loadStartupSettings() ran. Every entry point must ' +
        'call it at boot — see src/settings/runtime.ts.',
    );
  }
  return snapshot;
}

/** Test seam. Mirrors `__setNodeMap` and `__setMapping`. */
export function __setStartupSettings(values: Partial<StartupSettings>): void {
  snapshot = {
    attachPageImage: false,
    ocrFallbackEnabled: false,
    ...snapshot,
    ...values,
  };
}

/**
 * Back to the real uninitialised state, so the throw above can actually be asserted.
 *
 * Separate from `__setStartupSettings` because that one can only ever produce a *loaded*
 * snapshot, and a test for "refuses to be read before boot" that cannot reach the unloaded state
 * is a test that passes without testing anything.
 */
export function __resetStartupSettings(): void {
  snapshot = null;
}
