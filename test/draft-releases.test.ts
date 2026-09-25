/**
 * The "is there a newer engine" check (Q23's middle option, built 2026-09-25).
 *
 * The feed is injected rather than reached, so no test here touches the network. What is worth
 * asserting is not the happy path — it is every way this must decline to be useful:
 *
 *  - off unless a firm switched it on, because it is an outbound connection the appliance
 *    otherwise never makes;
 *  - a pre-release is not "the latest", because quietly treating one as such is how an
 *    unfinished tax engine ends up computing somebody's return;
 *  - an unreachable or malformed feed reports as unavailable and never throws, because an
 *    optional convenience must not break the page carrying the engine's real status;
 *  - and nothing in the module can install anything, which is the whole design.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { __clearReleaseCache, checkForNewerEngine } from '../src/draft/releases.ts';

/** The settings the module reads, stubbed so this file needs no database. */
const values = new Map<string, unknown>();
vi.mock('../src/settings/store.ts', () => ({
  setting: async (key: string) => values.get(key),
  invalidateSettingsCache: () => undefined,
}));

const FEED = 'https://example.invalid/releases/latest';

const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v2.1.0',
  published_at: '2026-09-20T10:00:00Z',
  html_url: 'https://example.invalid/releases/v2.1.0',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'opentax-linux-x64',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1234,
    },
  ],
  ...over,
});

const respond = (body: unknown, ok = true, status = 200): typeof fetch =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

beforeEach(() => {
  __clearReleaseCache();
  values.clear();
  values.set('engine.opentax_version', '2.0.4');
  values.set('engine.update_check_enabled', true);
  values.set('engine.release_feed_url', FEED);
});
afterEach(() => __clearReleaseCache());

describe('off by default', () => {
  it('reports disabled without reaching anything at all', async () => {
    values.set('engine.update_check_enabled', false);
    const fetchImpl = vi.fn();
    const res = await checkForNewerEngine({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res.enabled).toBe(false);
    expect(res.latest).toBeNull();
    expect(res.newerAvailable).toBe(false);
    // The outbound connection is the thing being opted into, so "off" must mean no request.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('what it reports when it can read the feed', () => {
  it('names a newer release and strips the tag’s leading v', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond(release()) });
    expect(res.newerAvailable).toBe(true);
    expect(res.latest).toMatchObject({ tag: 'v2.1.0', version: '2.1.0', assetName: 'opentax-linux-x64' });
    // The digest is unwrapped from GitHub's `sha256:` form into what the staging form wants.
    expect(res.latest!.sha256).toBe('a'.repeat(64));
    expect(res.unavailable).toBeNull();
  });

  it('says up to date when the newest release is what this deployment expects', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond(release({ tag_name: 'v2.0.4' })) });
    expect(res.newerAvailable).toBe(false);
    expect(res.latest!.version).toBe('2.0.4');
  });

  it('compares across the v, so v2.0.4 and 2.0.4 are the same release', async () => {
    values.set('engine.opentax_version', 'v2.0.4');
    const res = await checkForNewerEngine({ fetchImpl: respond(release({ tag_name: '2.0.4' })) });
    expect(res.newerAvailable).toBe(false);
  });

  it('reports no digest rather than a wrong one when the feed publishes none', async () => {
    const res = await checkForNewerEngine({
      fetchImpl: respond(release({ assets: [{ name: 'opentax-linux-x64', digest: null }] })),
    });
    expect(res.latest!.sha256).toBeNull();
    // A missing digest must not become an empty string that looks typed-in.
    expect(res.latest!.assetName).toBe('opentax-linux-x64');
  });
});

describe('the ways it must decline', () => {
  it('refuses to call a pre-release the latest', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond(release({ prerelease: true })) });
    expect(res.latest).toBeNull();
    expect(res.newerAvailable).toBe(false);
    expect(res.unavailable).toMatch(/pre-release/);
  });

  it('refuses a draft release the same way', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond(release({ draft: true })) });
    expect(res.latest).toBeNull();
    expect(res.unavailable).toMatch(/draft or pre-release/);
  });

  it('reports a non-200 as unavailable rather than throwing', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond({}, false, 503) });
    expect(res.unavailable).toMatch(/503/);
    expect(res.newerAvailable).toBe(false);
  });

  it('survives a feed that changed shape, because a convenience must not break the page', async () => {
    const res = await checkForNewerEngine({ fetchImpl: respond({ nothing: 'like a release' }) });
    expect(res.latest).toBeNull();
    expect(res.unavailable).not.toBeNull();
  });

  it('survives the network simply failing', async () => {
    const boom = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const res = await checkForNewerEngine({ fetchImpl: boom });
    expect(res.unavailable).toMatch(/ENOTFOUND/);
    // Still reports what this deployment expects, so the panel has something true to show.
    expect(res.expected).toBe('2.0.4');
  });
});

describe('it does not hammer a third party', () => {
  it('caches, and refreshes only when asked', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => release() }));
    const impl = fetchImpl as unknown as typeof fetch;
    await checkForNewerEngine({ fetchImpl: impl });
    await checkForNewerEngine({ fetchImpl: impl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await checkForNewerEngine({ fetchImpl: impl, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

/**
 * The design claim, asserted rather than only written down.
 *
 * "It reports and cannot install" is the entire argument for this feature existing over a
 * floating `latest`, and an argument that lives only in a comment is one a later change can
 * quietly break. If somebody adds a download here, this fails and they have to come and say so.
 */
describe('the design claim', () => {
  it('contains no download, write or execute path', () => {
    const src = readFileSync(new URL('../src/draft/releases.ts', import.meta.url), 'utf8');
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['writeFile', 'createWriteStream', 'spawn', 'exec', 'stageRelease', 'activate']) {
      expect(body, `releases.ts must not reference ${forbidden} — it reports, it does not install`).not.toContain(
        forbidden,
      );
    }
  });
});
