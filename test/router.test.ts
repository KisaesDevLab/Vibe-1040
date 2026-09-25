import { VibeAiError } from '@kisaes/vibe-ai-client';
import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/router/client.ts';

/**
 * The router sends two codes the SDK's type union does not enumerate. Both used to fall to
 * the `default` branch and park — which for `invalid_response` means parking forever for a
 * router that has already retried, walked the fallback chain, and given up.
 */
describe('classifyFailure on codes outside the SDK union', () => {
  it('treats invalid_response as permanent and carries the router reason', () => {
    const err = new VibeAiError('invalid_response', 502, 'forced-JSON response was truncated', undefined, {
      reason: 'json_truncated',
    });
    expect(classifyFailure(err)).toEqual({
      kind: 'permanent',
      code: 'invalid_response',
      message: 'forced-JSON response was truncated',
      reason: 'json_truncated',
    });
  });

  it('omits reason when the router sent none', () => {
    const err = new VibeAiError('invalid_response', 502, 'not valid JSON');
    expect(classifyFailure(err)).toEqual({ kind: 'permanent', code: 'invalid_response', message: 'not valid JSON' });
  });

  it('parks no_vision_provider — an admin fixes that by probing the model', () => {
    const err = new VibeAiError('no_vision_provider', 409, 'no vision-capable model bound');
    expect(classifyFailure(err).kind).toBe('park');
  });
});

describe('classifyFailure on the documented taxonomy', () => {
  it('retries rate_limited honoring retryAfterSeconds', () => {
    const f = classifyFailure(new VibeAiError('rate_limited', 429, 'slow down', 12));
    expect(f).toMatchObject({ kind: 'retry', afterSeconds: 12 });
  });

  it('never retries scrubber_blocked', () => {
    expect(classifyFailure(new VibeAiError('scrubber_blocked', 422, 'blocked')).kind).toBe('permanent');
  });

  it('parks anything that is not a VibeAiError', () => {
    expect(classifyFailure(new Error('socket hang up'))).toMatchObject({ kind: 'park', code: 'unknown' });
  });
});

/**
 * The version this app stamps on its Router registrations and its review exports.
 *
 * `APP_VERSION` is a literal in `src/router/client.ts` because `rootDir` is `src` and importing
 * `package.json` would drag the manifest into `dist/`. The price of that duplication is drift,
 * and it was paid: v0.11.0 was built and released stamping `0.10.0`, through a green CI, a
 * green release gate and a merge — because nothing compared them. This is that comparison.
 */
describe('APP_VERSION', () => {
  it('matches the version in package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { APP_VERSION } = await import('../src/router/client.ts');

    const manifest = JSON.parse(
      await readFile(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };

    expect(
      APP_VERSION,
      'bump APP_VERSION in src/router/client.ts whenever package.json moves — a release that ' +
        'stamps the wrong version on a task-class registration is a release nobody can trace',
    ).toBe(manifest.version);
  });
});
