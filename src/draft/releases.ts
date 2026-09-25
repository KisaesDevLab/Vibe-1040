/**
 * "Is there a newer OpenTax?" — and nothing else (QUESTIONS.md Q23's middle option, built
 * 2026-09-25 when Kurt asked how to always run the latest).
 *
 * This module **reads**. It does not download a binary, does not stage one, does not activate
 * one, and has no code path that could. That is the whole design, and it is the answer to a
 * request for "always use the latest": §14 pins the engine and verifies it by checksum because
 * this is a young, largely AI-maintained tax engine, and — measured on 2.0.4 — a release that
 * renames an *optional* field has its amounts silently dropped, so the line reads as absent
 * rather than wrong. Automatic upgrading would make that failure arrive unannounced. Being
 * *told* a release exists costs nothing and removes the only real argument for floating.
 *
 * **The checksum this reports is not independent verification.** It comes from the same place as
 * the binary, so a compromised release would publish a matching digest. It is here to save
 * retyping into the staging form, and the honest protections stay where they were: the digest is
 * checked before the candidate is ever executed, its own field catalogue is checked against the
 * node map, and `npm run draft -- --truth` measures behaviour rather than names. The UI says
 * this rather than implying the number means more than it does.
 *
 * **Off unless a firm turns it on.** It opens an outbound connection from the appliance to a
 * host it otherwise never contacts, which is a network-policy and WISP question (Q21), not a
 * default. Nothing taxpayer-related is sent — it is an unauthenticated GET of public release
 * metadata — but "the appliance talks to GitHub now" is a sentence somebody has to agree to.
 */
import { z } from 'zod';
import { setting } from '../settings/store.ts';

/**
 * The subset of the release feed this reads, and nothing beyond it.
 *
 * `.catch` on each optional field rather than `.optional()` alone: this is third-party JSON that
 * can change shape without warning, and a check that *cannot fail* is the point — an upgrade
 * notice is a convenience, and a convenience must never be able to break the admin page that
 * carries the engine's real status.
 */
const releaseFeed = z.object({
  tag_name: z.string().min(1).max(64),
  published_at: z.string().max(64).nullish().catch(null),
  html_url: z.string().max(512).nullish().catch(null),
  draft: z.boolean().nullish().catch(false),
  prerelease: z.boolean().nullish().catch(false),
  assets: z
    .array(
      z.object({
        name: z.string().max(256),
        digest: z.string().max(200).nullish().catch(null),
        size: z.number().nullish().catch(null),
      }),
    )
    .catch([]),
});

export interface ReleaseCheck {
  /** False when the firm has not switched the check on; the page says so rather than erroring. */
  enabled: boolean;
  /** The pinned version this deployment intends to run, for the comparison. */
  expected: string;
  latest: {
    tag: string;
    /** The tag with a leading `v` stripped, which is how the binary reports itself. */
    version: string;
    publishedAt: string | null;
    url: string | null;
    /** The release's own published digest for the linux asset, when it publishes one. */
    assetName: string | null;
    sha256: string | null;
  } | null;
  /** True when `latest` is a different version from `expected`. Never acted on. */
  newerAvailable: boolean;
  /**
   * Why there is no answer, when there is none. Populated rather than thrown: an optional
   * convenience being unreachable is not an error state for the page it sits on.
   */
  unavailable: string | null;
  checkedAt: string;
}

/** Cached because an admin refreshing a page must not hammer a third party. */
let cache: { at: number; value: ReleaseCheck } | null = null;
const CACHE_TTL_MS = 15 * 60_000;

export function __clearReleaseCache(): void {
  cache = null;
}

const bare = (v: string): string => v.replace(/^v/, '');

export async function checkForNewerEngine(
  options: { force?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<ReleaseCheck> {
  const expected = await setting<string>('engine.opentax_version');
  const base: Omit<ReleaseCheck, 'latest' | 'newerAvailable' | 'unavailable'> = {
    enabled: true,
    expected,
    checkedAt: new Date().toISOString(),
  };

  if (!(await setting<boolean>('engine.update_check_enabled'))) {
    return {
      ...base,
      enabled: false,
      latest: null,
      newerAvailable: false,
      unavailable: null,
    };
  }

  if (!options.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const url = await setting<string>('engine.release_feed_url');
  const doFetch = options.fetchImpl ?? fetch;
  let value: ReleaseCheck;

  try {
    const res = await doFetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vibe-1040' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`the release feed answered ${res.status}`);

    const parsed = releaseFeed.parse(await res.json());
    if (parsed.draft || parsed.prerelease) {
      // A pre-release is not something to tell a firm to upgrade to, and quietly treating one as
      // "the latest" is how an unfinished engine ends up computing somebody's return.
      throw new Error(`the newest release (${parsed.tag_name}) is a draft or pre-release`);
    }

    const asset =
      parsed.assets.find((a) => a.name === 'opentax-linux-x64') ??
      parsed.assets.find((a) => /linux.*x64|x64.*linux/i.test(a.name)) ??
      null;
    // GitHub reports a digest as `sha256:<hex>`; store the hex the staging form wants.
    const digest = asset?.digest ?? null;
    const sha256 = digest && /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7) : null;

    value = {
      ...base,
      latest: {
        tag: parsed.tag_name,
        version: bare(parsed.tag_name),
        publishedAt: parsed.published_at ?? null,
        url: parsed.html_url ?? null,
        assetName: asset?.name ?? null,
        sha256,
      },
      newerAvailable: bare(parsed.tag_name) !== bare(expected),
      unavailable: null,
    };
  } catch (err) {
    value = {
      ...base,
      latest: null,
      newerAvailable: false,
      unavailable: (err as Error).message,
    };
  }

  cache = { at: Date.now(), value };
  return value;
}
