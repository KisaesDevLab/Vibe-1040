import { afterEach, describe, expect, it } from 'vitest';
import { shouldTranscribe } from '../src/ocr/transcribe.ts';
import { __setStartupSettings } from '../src/settings/runtime.ts';

/**
 * The gate now reads the **boot snapshot** rather than the environment (`src/settings/runtime.ts`).
 *
 * That is why this file no longer stubs an env var and re-imports the module: the value is a
 * setting an admin can change, captured once at startup so the classes registered with the router
 * and the code that calls them cannot disagree. Setting it here is one line and the module under
 * test does not have to be reloaded, which also means these assertions run against the same
 * instance the rest of the suite does.
 */
const off = (): void => __setStartupSettings({ ocrFallbackEnabled: false });
const on = (): void => __setStartupSettings({ ocrFallbackEnabled: true });

afterEach(off);

/**
 * An optional step must cost nothing until someone asks for it, and this is the assertion that
 * matters most — it is the deployment default.
 */
describe('shouldTranscribe, fallback disabled', () => {
  const raster = { route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: 'k' };

  it('never transcribes while the fallback is off, even for a page that needs it', () => {
    off();
    expect(shouldTranscribe(raster)).toBe(false);
  });
});

describe('shouldTranscribe, gating rules', () => {
  it('transcribes a raster page with no text layer', () => {
    on();
    expect(shouldTranscribe({ route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: 'k' })).toBe(true);
  });

  it('refuses a page whose text layer is exact, rather than spending a call on a worse copy', () => {
    on();
    expect(
      shouldTranscribe({ route: 'text_layer', textLayer: 'Form W-2 Wage and Tax Statement', ocrText: null, rasterStorageKey: 'k' }),
    ).toBe(false);
  });

  it('still transcribes a page routed to raster despite carrying some stray text', () => {
    on();
    expect(shouldTranscribe({ route: 'raster', textLayer: 'garbled', ocrText: null, rasterStorageKey: 'k' })).toBe(true);
  });

  it('does not transcribe twice, so a reprocess costs nothing', () => {
    on();
    expect(shouldTranscribe({ route: 'raster', textLayer: null, ocrText: 'already read', rasterStorageKey: 'k' })).toBe(false);
  });

  it('treats an empty transcription as done rather than retrying forever', () => {
    on();
    expect(shouldTranscribe({ route: 'raster', textLayer: null, ocrText: '', rasterStorageKey: 'k' })).toBe(false);
  });

  it('has nothing to send when the page was never rasterized', () => {
    on();
    expect(shouldTranscribe({ route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: null })).toBe(false);
  });
});

/**
 * The snapshot refuses to be read before boot loaded it.
 *
 * Worth a test because the tempting implementation is to fall back to the environment, and that
 * would reintroduce exactly the bug the module exists to prevent: the API and the worker
 * disagreeing about whether a task class was registered, depending on which one remembered to
 * initialise. A loud throw at boot is recoverable; a silent divergence in production is not.
 */
describe('the boot snapshot', () => {
  afterEach(off);

  it('throws rather than guessing when it was never loaded', async () => {
    const { __resetStartupSettings, startupSettings } = await import('../src/settings/runtime.ts');
    __resetStartupSettings();
    expect(() => startupSettings()).toThrow(/loadStartupSettings/);
    // And the gate that depends on it fails loudly too, rather than reading as "off".
    expect(() => shouldTranscribe({ route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: 'k' })).toThrow();
  });
});
