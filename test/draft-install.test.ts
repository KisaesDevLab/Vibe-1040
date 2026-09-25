/**
 * Staging an engine upgrade (QUESTIONS.md Q23), over real HTTP against a real child process.
 *
 * This file spawns its **own** wrapper, with a staging directory, on its own port. The shared
 * one from the global setup deliberately has no staging directory configured — which is the
 * default a deployment ships with, and the first thing asserted here.
 *
 * What is exercised for real: the digest check, the version check, the path-traversal refusal,
 * the catalogue of the *staged* binary, activation by rename, rollback, and discard. What is
 * **not** exercised is the network download: no test here reaches the internet, so the `url`
 * form is covered only by its refusals. The report says so rather than implying otherwise.
 *
 * The "binary" is `test/helpers/fake-opentax.mjs`, so a second copy of it with a different
 * version string stands in for an upgrade.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 18_239;
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | undefined;
let staging = '';
let livePath = '';
let candidateSha = '';

/**
 * The sidecar's staging responses, written out rather than read as `any`.
 *
 * Loose where the sidecar is loose — a refusal and a success share the envelope — but named, so
 * a renamed key on the wire between the app and its own sidecar cannot go on compiling.
 */
interface StagedBody {
  allowed?: boolean;
  staged?: { version: string | null; sha256: string; stagedAt: string; path: string } | null;
  live?: { version: string; path: string } | null;
  previous?: boolean;
  version?: string;
  sha256?: string;
  from?: string;
  discarded?: boolean;
  engineVersion?: string;
  nodes?: Record<string, { implemented: boolean }>;
  error?: string;
  detail?: string;
}

const get = async (path: string): Promise<{ status: number; body: StagedBody }> => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as StagedBody };
};
const send = async (
  method: string,
  path: string,
  payload?: unknown,
): Promise<{ status: number; body: StagedBody }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
  return { status: res.status, body: (await res.json()) as StagedBody };
};

/** A stand-in "release": the fake engine, with its version string rewritten. */
async function makeCandidate(dir: string, name: string, version: string): Promise<string> {
  const source = await readFile(join(here, 'helpers', 'fake-opentax.mjs'), 'utf8');
  const rewritten = source.replace(/9\.9\.9-fake/g, version);
  // Only a different version is a rewrite; the live copy asks for the original on purpose.
  if (version !== '9.9.9-fake') {
    expect(rewritten, 'the fake engine should carry a version string to rewrite').not.toBe(source);
  }
  const path = join(dir, name);
  await writeFile(path, rewritten);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  staging = await mkdtemp(join(tmpdir(), 'v1040-staging-'));
  const live = await mkdtemp(join(tmpdir(), 'v1040-live-'));
  livePath = await makeCandidate(live, 'opentax', '9.9.9-fake');
  await makeCandidate(staging, 'opentax-next', '9.9.10-fake');
  candidateSha = createHash('sha256')
    .update(await readFile(join(staging, 'opentax-next')))
    .digest('hex');

  child = spawn(process.execPath, [join(here, '..', 'opentax', 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), OPENTAX_BIN: livePath, OPENTAX_STAGING_DIR: staging },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => {
    if (process.env['DEBUG_WRAPPER']) process.stderr.write(`[staging-wrapper] ${d}`);
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the staging wrapper never became healthy');
}, 60_000);

afterAll(async () => {
  child?.kill('SIGTERM');
  if (staging) await rm(staging, { recursive: true, force: true });
  if (livePath) await rm(dirname(livePath), { recursive: true, force: true });
});

describe('staging is off unless a deployment configures it', () => {
  it('reports `allowed: false` on the shared wrapper rather than erroring', async () => {
    // The global setup's wrapper has no staging directory — the shipped default. A page has to
    // be able to say "this deployment cannot do that" without treating it as a failure.
    const { OPENTAX_TEST_URL } = await import('./helpers/opentax-global.ts');
    const res = await fetch(`${OPENTAX_TEST_URL}/staged`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: false, staged: null });
  });

  it('refuses every act that would change a binary', async () => {
    const { OPENTAX_TEST_URL } = await import('./helpers/opentax-global.ts');
    for (const [method, path] of [
      ['POST', '/staged'],
      ['POST', '/staged/activate'],
      ['DELETE', '/staged'],
      ['GET', '/staged/catalog?nodes=w2'],
    ] as const) {
      const res = await fetch(`${OPENTAX_TEST_URL}${path}`, {
        method,
        ...(method === 'POST' && path === '/staged'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(409);
    }
  });
});

describe('a candidate is verified before it is ever run', () => {
  it('refuses a digest that does not match, and keeps nothing', async () => {
    const res = await send('POST', '/staged', {
      version: '9.9.10-fake',
      sha256: 'a'.repeat(64),
      file: 'opentax-next',
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/checksum mismatch/);
    // Nothing kept: a binary that failed its digest must not be sitting there to activate.
    expect((await get('/staged')).body.staged).toBeNull();
  });

  it('refuses a version that disagrees with the one asked for', async () => {
    // A release re-tagged under the same name is exactly what a version pin plus a checksum
    // exists to catch, and the checksum alone would not catch it.
    const res = await send('POST', '/staged', {
      version: '9.9.99-fake',
      sha256: candidateSha,
      file: 'opentax-next',
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/reports 9\.9\.10-fake, not the 9\.9\.99-fake/);
    expect((await get('/staged')).body.staged).toBeNull();
  });

  it('refuses a file name that tries to leave the staging directory', async () => {
    for (const file of ['../opentax', 'sub/opentax', '.hidden']) {
      const res = await send('POST', '/staged', { version: '9.9.10-fake', sha256: candidateSha, file });
      expect(res.status, file).toBe(409);
      expect(res.body.detail, file).toMatch(/plain name inside the staging directory|no such file/);
    }
  });

  it('refuses a url that is not https, and never reaches the network for it', async () => {
    const res = await send('POST', '/staged', {
      version: '9.9.10-fake',
      sha256: candidateSha,
      url: 'http://example.invalid/opentax',
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/must be https/);
  });

  it('refuses a version or digest that is not even the right shape', async () => {
    expect((await send('POST', '/staged', { version: 'latest', sha256: candidateSha, file: 'opentax-next' })).status).toBe(409);
    expect((await send('POST', '/staged', { version: '9.9.10-fake', sha256: 'nope', file: 'opentax-next' })).status).toBe(409);
  });
});

describe('the whole staged upgrade, end to end', () => {
  it('stages, catalogues the candidate, activates, rolls back and discards', async () => {
    const staged = await send('POST', '/staged', {
      version: '9.9.10-fake',
      sha256: candidateSha,
      file: 'opentax-next',
    });
    expect(staged.status).toBe(200);
    expect(staged.body).toMatchObject({ version: '9.9.10-fake', sha256: candidateSha, from: 'file:opentax-next' });

    // Staged, and **not** serving. This is the whole point of the design.
    expect((await get('/health')).body.version).toBe('9.9.9-fake');
    const state = await get('/staged');
    expect(state.body.staged!.version).toBe('9.9.10-fake');
    expect(state.body.live!.version).toBe('9.9.9-fake');

    // The candidate's own field catalogue, which is what the app checks the node map against
    // before anybody activates: a renamed optional field is accepted and ignored by the engine,
    // so this is the only place it can be caught.
    const catalog = await get('/staged/catalog?nodes=w2,f1099int');
    expect(catalog.status).toBe(200);
    expect(catalog.body.engineVersion).toBe('9.9.10-fake');
    expect(Object.keys(catalog.body.nodes ?? {})).toEqual(expect.arrayContaining(['w2', 'f1099int']));

    const activated = await send('POST', '/staged/activate');
    expect(activated.status).toBe(200);
    expect(activated.body.version).toBe('9.9.10-fake');
    // Live now, with no restart — the rename is picked up by the next spawn.
    expect((await get('/health')).body.version).toBe('9.9.10-fake');
    const after = await get('/staged');
    expect(after.body.staged).toBeNull();
    expect(after.body.previous, 'the outgoing binary is kept, so a bad upgrade is one button to undo').toBe(true);

    const rolled = await send('POST', '/staged/rollback');
    expect(rolled.status).toBe(200);
    expect((await get('/health')).body.version).toBe('9.9.9-fake');
    // And only once: the previous binary is consumed by the rollback.
    expect((await send('POST', '/staged/rollback')).status).toBe(409);
  });

  it('discards a staged candidate without touching what is live', async () => {
    await send('POST', '/staged', { version: '9.9.10-fake', sha256: candidateSha, file: 'opentax-next' });
    expect((await get('/staged')).body.staged).not.toBeNull();

    expect((await send('DELETE', '/staged')).status).toBe(200);
    expect((await get('/staged')).body.staged).toBeNull();
    expect((await get('/health')).body.version).toBe('9.9.9-fake');
  });

  it('will not activate or catalogue when nothing is staged', async () => {
    expect((await get('/staged')).body.staged).toBeNull();
    expect((await send('POST', '/staged/activate')).status).toBe(409);
    expect((await get('/staged/catalog?nodes=w2')).status).toBe(409);
  });
});
