/**
 * The OpenTax sidecar client (P17 stage 2).
 *
 * The engine is a separate process, reached over the internal Docker network. That is not an
 * accident of packaging: it is the arm's-length reading of its AGPL licence and it keeps the
 * integration severable (CLAUDE.md §13, QUESTIONS.md Q22). **Do not move this in-process and
 * do not vendor the engine's source into `src/`.**
 *
 * Failure is handled by taxonomy rather than by exit code or HTTP status, the same discipline
 * `src/router` uses, and an absent engine is a reported degraded state rather than a crash —
 * the precedent is router-down parking (§3): a bundle is never failed because an optional
 * checking aid is unreachable.
 */
import { env } from '../config/env.ts';

export type DraftEngineErrorCode =
  /** Nothing is listening. The service is not deployed, or not started. */
  | 'engine_unreachable'
  /** Reached it, and it did not answer inside OPENTAX_TIMEOUT_MS. */
  | 'engine_timeout'
  /** It answered, and refused the input. An app bug or a stale node map — log loudly. */
  | 'invalid_input'
  /** It answered with something this app cannot parse. Also an app bug or a version drift. */
  | 'invalid_response'
  /** It answered with a failure of its own. */
  | 'engine_error';

export class DraftEngineError extends Error {
  readonly code: DraftEngineErrorCode;
  readonly detail: string | undefined;

  constructor(code: DraftEngineErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'DraftEngineError';
    this.code = code;
    this.detail = detail;
  }

  /** True for the codes that mean "the engine is not here", not "the input was wrong". */
  get isUnavailable(): boolean {
    return this.code === 'engine_unreachable' || this.code === 'engine_timeout';
  }
}

export interface EngineHealth {
  ok: boolean;
  /** What the sidecar reports, which may differ from OPENTAX_VERSION. */
  version: string | null;
  /** Populated when `ok` is false. */
  reason?: string;
}

/** One `form add` the engine refused, named so a reviewer can see which document it was. */
export interface EngineNodeRejection {
  nodeType: string;
  documentId: string | null;
  message: string;
}

/** What the engine computed. Shapes mirror its `return get` and `return validate --format json`. */
export interface EngineResult {
  returnId: string;
  year: number;
  engineVersion: string;
  summary: Record<string, number>;
  /**
   * **Flat**, keyed by line name (`line1a_wages`, `line2b_taxable_interest`). Verified against
   * engine 2.0.4: only Form 1040 lines are surfaced, Schedule 1 detail is not, and a value may
   * arrive as a number, a float, or a two-element array of the same figure.
   */
  lines: Record<string, unknown>;
  forms: string[];
  warnings: string[];
  /** MeF business-rule diagnostics. This app reads them; it never emits MeF XML. */
  validation: {
    hard: { code: string; message: string }[];
    soft: { code: string; message: string }[];
  };
  /** Nodes the engine would not accept. A draft with these is reported as partial. */
  rejected: EngineNodeRejection[];
}

export interface EngineRequestNode {
  nodeType: string;
  documentId: string | null;
  payload: Record<string, unknown>;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.OPENTAX_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.OPENTAX_URL}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DraftEngineError(
        'engine_timeout',
        `the OpenTax engine did not answer within ${env.OPENTAX_TIMEOUT_MS} ms`,
      );
    }
    throw new DraftEngineError(
      'engine_unreachable',
      `cannot reach the OpenTax engine at ${env.OPENTAX_URL}`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  // 400 is the engine refusing a payload; 409 is the sidecar refusing an action because the
  // world is not what the request assumed — nothing staged, a checksum that does not match, a
  // version that disagrees. Both are the caller's problem and both carry the reason.
  if (res.status === 400 || res.status === 409) {
    throw new DraftEngineError('invalid_input', 'the OpenTax sidecar refused the request', text.slice(0, 2000));
  }
  if (!res.ok) {
    throw new DraftEngineError('engine_error', `the OpenTax engine returned ${res.status}`, text.slice(0, 2000));
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DraftEngineError('invalid_response', 'the OpenTax engine returned unparseable JSON', text.slice(0, 500));
  }
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' });

/**
 * Ask the sidecar whether it is there and which engine it holds.
 *
 * Never throws. Callers report degraded rather than refusing to answer, so a missing optional
 * service cannot take the app down with it.
 *
 * **This blocks for up to five seconds and must never be awaited on a liveness path** — use
 * `lastKnownEngineHealth()` there. See the comment on that function: awaiting this from
 * `GET /health` took an appliance down on 2026-09-27.
 */
export async function engineHealth(): Promise<EngineHealth> {
  const controller = new AbortController();
  // Health is a liveness question, not a computation: a short, fixed budget.
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${env.OPENTAX_URL}/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, version: null, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    return { ok: true, version: typeof body.version === 'string' ? body.version : null };
  } catch (err) {
    return {
      ok: false,
      version: null,
      reason: err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The engine's reachability **without waiting for it** — for `GET /health` and nothing else.
 *
 * ## Why this exists
 *
 * `/health` awaited `engineHealth()`, whose budget is five seconds, and the container's
 * healthcheck has a timeout of five seconds. With the sidecar unreachable those two numbers are
 * the same number, so the probe could never win: every `/health` took *at least* 5000 ms, the
 * healthcheck killed it at exactly 5000 ms, and the container never reported healthy. The
 * appliance then gave up after its start period plus five retries — 30s + 5 × 30s = the 180s in
 * the failure message. Observed on a real deployment on 2026-09-27, where the engine was enabled
 * but its compose service had not been started.
 *
 * The route's own comment said an unreachable engine is "never a reason for `ok: false`", and
 * that was true of the JSON it returned and false of the latency it took. **An optional
 * dependency must not be able to fail a liveness check, and the way to guarantee that is to
 * never call it from one** — not to pick a smaller timeout, which is the same bug with a
 * different constant.
 *
 * So: return whatever the last probe found, immediately, and refresh in the background when the
 * answer is stale. A cold cache reports `not yet probed` rather than waiting to find out.
 */
const PROBE_TTL_MS = 30_000;
let lastProbe: { at: number; value: EngineHealth } | null = null;
let probeInFlight: Promise<void> | null = null;

function refreshEngineHealthInBackground(): void {
  if (probeInFlight) return;
  probeInFlight = engineHealth()
    .then((value) => {
      lastProbe = { at: Date.now(), value };
    })
    .catch(() => {
      // engineHealth never throws; this is belt and braces so a rejection cannot wedge the
      // in-flight guard and leave the probe permanently stuck.
      lastProbe = { at: Date.now(), value: { ok: false, version: null, reason: 'unreachable' } };
    })
    .finally(() => {
      probeInFlight = null;
    });
}

export function lastKnownEngineHealth(): EngineHealth {
  const fresh = lastProbe !== null && Date.now() - lastProbe.at < PROBE_TTL_MS;
  if (!fresh) refreshEngineHealthInBackground();
  return lastProbe?.value ?? { ok: false, version: null, reason: 'not yet probed' };
}

/** Test seam, so a test can assert the liveness path without a sidecar. */
export function __setLastEngineProbe(value: EngineHealth | null): void {
  lastProbe = value === null ? null : { at: Date.now(), value };
}

/** One input node's field catalogue, as the engine itself reports it. */
export interface EngineNodeCatalog {
  implemented: boolean;
  /** The array a payload becomes an item of — `w2s` for `w2`. Null for a flat node. */
  collection?: string | null;
  /** The fields a `form add` payload may carry, and whether the engine requires each. */
  fields?: Record<string, { type: string; required: boolean }>;
  /** Names the node carries elsewhere — a flat node's nested collections, say. */
  otherFields?: string[];
  /** Populated when `implemented` is false. */
  reason?: string;
}

export interface EngineCatalog {
  engineVersion: string;
  nodes: Record<string, EngineNodeCatalog>;
}

/**
 * Ask the engine what fields it actually has, for the node types named.
 *
 * Used to catch a field renamed between engine releases. See `src/draft/catalog.ts` for why
 * that is worth a round trip: a renamed *optional* field is accepted and ignored, so the
 * amount disappears with no error anywhere.
 */
export async function fetchCatalog(nodeTypes: readonly string[]): Promise<EngineCatalog> {
  const query = encodeURIComponent([...new Set(nodeTypes)].join(','));
  const body = await get<Partial<EngineCatalog>>(`/catalog?nodes=${query}`);
  if (typeof body.nodes !== 'object' || body.nodes === null) {
    throw new DraftEngineError('invalid_response', 'the OpenTax sidecar returned a catalog with no nodes');
  }
  return {
    engineVersion: typeof body.engineVersion === 'string' ? body.engineVersion : 'unknown',
    nodes: body.nodes,
  };
}

// ── staged install (Q23) ─────────────────────────────────────────────────────
//
// The sidecar owns the binary, so it does the staging; this is the app's side of those calls.
// Every one of them is inert unless the deployment configured a staging directory, and the
// sidecar says so in `allowed` rather than erroring, so the page can explain itself.

export interface StagedEngineState {
  allowed: boolean;
  staged: { version: string | null; sha256: string; stagedAt: string; path: string } | null;
  live: { version: string; path: string } | null;
  previous: boolean;
}

export interface StagedRelease {
  version: string;
  sha256: string;
  /** `https://…` for a download, or `file:<name>` for one an operator dropped in place. */
  from: string;
  path: string;
}

export async function stagedState(): Promise<StagedEngineState> {
  return get<StagedEngineState>('/staged');
}

/**
 * Stage a candidate: download or copy it, verify its digest, and read its version back.
 *
 * A refusal here is the sidecar saying the request was wrong about the world — a checksum that
 * does not match, a version that disagrees, a file that is not there — so it comes back as
 * `invalid_input` rather than as an engine failure, and the reason is the sidecar's own words.
 */
export async function stageRelease(spec: {
  version: string;
  sha256: string;
  url?: string | undefined;
  file?: string | undefined;
}): Promise<StagedRelease> {
  return post<StagedRelease>('/staged', spec);
}

/** The catalogue of the **staged** binary, for checking a candidate before it serves anything. */
export async function fetchStagedCatalog(nodeTypes: readonly string[]): Promise<EngineCatalog> {
  const query = encodeURIComponent([...new Set(nodeTypes)].join(','));
  const body = await get<Partial<EngineCatalog>>(`/staged/catalog?nodes=${query}`);
  if (typeof body.nodes !== 'object' || body.nodes === null) {
    throw new DraftEngineError('invalid_response', 'the OpenTax sidecar returned a catalog with no nodes');
  }
  return {
    engineVersion: typeof body.engineVersion === 'string' ? body.engineVersion : 'unknown',
    nodes: body.nodes,
  };
}

export async function activateStaged(): Promise<{ version: string; path: string }> {
  return post<{ version: string; path: string }>('/staged/activate', {});
}

export async function rollbackEngine(): Promise<{ version: string; path: string }> {
  return post<{ version: string; path: string }>('/staged/rollback', {});
}

export async function discardStaged(): Promise<{ discarded: boolean }> {
  return request<{ discarded: boolean }>('/staged', { method: 'DELETE' });
}

/** Compute a return from the nodes the translator produced. */
export async function computeReturn(
  taxYear: number,
  nodes: readonly EngineRequestNode[],
): Promise<EngineResult> {
  const body = await post<Partial<EngineResult>>('/draft', { taxYear, nodes });
  if (typeof body.returnId !== 'string' || typeof body.lines !== 'object' || body.lines === null) {
    throw new DraftEngineError(
      'invalid_response',
      'the OpenTax engine returned a body with no returnId or no lines',
    );
  }
  return {
    returnId: body.returnId,
    year: typeof body.year === 'number' ? body.year : taxYear,
    engineVersion: typeof body.engineVersion === 'string' ? body.engineVersion : 'unknown',
    summary: (body.summary ?? {}),
    lines: body.lines,
    forms: Array.isArray(body.forms) ? body.forms : [],
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
    validation: {
      hard: body.validation?.hard ?? [],
      soft: body.validation?.soft ?? [],
    },
    rejected: Array.isArray(body.rejected) ? body.rejected : [],
  };
}
