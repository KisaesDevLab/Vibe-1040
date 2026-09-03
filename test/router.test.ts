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
    const err = new VibeAiError('invalid_response' as never, 502, 'forced-JSON response was truncated', undefined, {
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
    const err = new VibeAiError('invalid_response' as never, 502, 'not valid JSON');
    expect(classifyFailure(err)).toEqual({ kind: 'permanent', code: 'invalid_response', message: 'not valid JSON' });
  });

  it('parks no_vision_provider — an admin fixes that by probing the model', () => {
    const err = new VibeAiError('no_vision_provider' as never, 409, 'no vision-capable model bound');
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
