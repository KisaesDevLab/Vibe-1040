import { describe, expect, it } from 'vitest';
import { shouldTranscribe } from '../src/ocr/transcribe.ts';

/**
 * `OCR_FALLBACK_ENABLED` is unset in the test environment, so the gate is closed. That is the
 * assertion that matters most: an optional step must cost nothing until someone asks for it.
 */
describe('shouldTranscribe, fallback disabled', () => {
  const raster = { route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: 'k' };

  it('never transcribes while the fallback is off, even for a page that needs it', () => {
    expect(shouldTranscribe(raster)).toBe(false);
  });
});

describe('shouldTranscribe, gating rules', () => {
  /** Re-parse config with the flag on, then re-import so the module sees it. */
  async function withFallbackOn() {
    const { vi } = await import('vitest');
    vi.stubEnv('OCR_FALLBACK_ENABLED', 'true');
    vi.resetModules();
    return (await import('../src/ocr/transcribe.ts')).shouldTranscribe;
  }

  it('transcribes a raster page with no text layer', async () => {
    const fn = await withFallbackOn();
    expect(fn({ route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: 'k' })).toBe(true);
  });

  it('refuses a page whose text layer is exact, rather than spending a call on a worse copy', async () => {
    const fn = await withFallbackOn();
    expect(
      fn({ route: 'text_layer', textLayer: 'Form W-2 Wage and Tax Statement', ocrText: null, rasterStorageKey: 'k' }),
    ).toBe(false);
  });

  it('still transcribes a page routed to raster despite carrying some stray text', async () => {
    const fn = await withFallbackOn();
    expect(fn({ route: 'raster', textLayer: 'garbled', ocrText: null, rasterStorageKey: 'k' })).toBe(true);
  });

  it('does not transcribe twice, so a reprocess costs nothing', async () => {
    const fn = await withFallbackOn();
    expect(fn({ route: 'raster', textLayer: null, ocrText: 'already read', rasterStorageKey: 'k' })).toBe(false);
  });

  it('treats an empty transcription as done rather than retrying forever', async () => {
    const fn = await withFallbackOn();
    expect(fn({ route: 'raster', textLayer: null, ocrText: '', rasterStorageKey: 'k' })).toBe(false);
  });

  it('has nothing to send when the page was never rasterized', async () => {
    const fn = await withFallbackOn();
    expect(fn({ route: 'raster', textLayer: null, ocrText: null, rasterStorageKey: null })).toBe(false);
  });
});
