/**
 * The only path to AI in this repo (§3).
 *
 * Wraps `@kisaes/vibe-ai-client` with the three things this app needs on top of it:
 * startup assertions, error-taxonomy dispatch, and Router-unavailable parking.
 *
 * There is no fallback path. If the router is down, work parks and the UI says so — it
 * does not degrade to some other provider, because there is no other provider.
 */
import { VibeAiClient, VibeAiError } from '@kisaes/vibe-ai-client';
import type { ChatMessage, RequestOptions } from '@kisaes/vibe-ai-client';
import { env } from '../config/env.ts';
import { APP_NAME, DECLARATIONS, TASK_CLASS, type TaskClassKey } from './task-classes.ts';

export const APP_VERSION = '0.0.4';

export const ai = new VibeAiClient({
  baseUrl: env.VIBE_AI_ROUTER_URL,
  token: env.VIBE_AI_TOKEN,
  // A layout pass over a dense page is a big non-streaming completion; the 120s default
  // is too tight for it, and a timeout here looks like a bad extraction rather than a
  // slow one.
  timeoutMs: 300_000,
});

// ── error handling ───────────────────────────────────────────────────────────

export type RouterFailure =
  | { kind: 'retry'; afterSeconds: number; code: string; message: string }
  | { kind: 'park'; code: string; message: string }
  | { kind: 'permanent'; code: string; message: string; reason?: string };

/**
 * Dispatch on the taxonomy code, never on HTTP status (§3).
 *
 * `scrubber_blocked` is deliberately permanent rather than parked: retrying sends the same
 * protected data again, and the answer will not change.
 *
 * Two codes the SDK's type union does not enumerate but the router does send, verbatim:
 *  - `invalid_response` — the router validated the forced-JSON body itself, already retried
 *    the same model and walked the fallback chain, and gave up. `detail.reason` says why
 *    (`json_truncated`, `schema_violation`, ...). Parking cannot help; it is permanent.
 *  - `no_vision_provider` — the class is bound to a model whose vision capability was never
 *    probed and enabled. An admin will fix that; park until they do.
 */
export function classifyFailure(err: unknown): RouterFailure {
  if (!(err instanceof VibeAiError)) {
    return { kind: 'park', code: 'unknown', message: (err as Error).message };
  }
  // The SDK passes the wire code through untouched, so widen past its declared union.
  const code: string = err.code;
  switch (code) {
    case 'invalid_response': {
      const reason = err.detail?.['reason'];
      return {
        kind: 'permanent',
        code,
        message: err.message,
        ...(typeof reason === 'string' ? { reason } : {}),
      };
    }
    case 'no_vision_provider':
      return { kind: 'park', code, message: err.message };
    case 'rate_limited':
    case 'provider_unavailable':
      return {
        kind: 'retry',
        afterSeconds: err.retryAfterSeconds ?? 30,
        code: err.code,
        message: err.message,
      };
    case 'auth_error':
      // A bad app token is an operator problem, not a transient one. Park so the whole
      // bundle does not fail while someone rotates it.
      return { kind: 'park', code: err.code, message: err.message };
    case 'scrubber_blocked':
    case 'policy_blocked':
    case 'budget_exceeded':
    case 'capability_missing':
    case 'invalid_request':
    case 'context_exceeded':
    case 'output_truncated':
    case 'content_filtered':
      return { kind: 'permanent', code: err.code, message: err.message };
    default:
      return { kind: 'park', code: err.code, message: err.message };
  }
}

export interface CallOptions extends Omit<RequestOptions, 'responseFormat'> {
  /** Attribution for the router ledger. */
  userId?: string;
  bundleId?: string;
}

/**
 * Forced-JSON call with bounded retry. Schema *validation* stays the caller's job — the
 * SDK only guarantees the response parsed, and every call site here has a zod schema.
 */
export async function completeJson<T>(
  taskClass: TaskClassKey,
  messages: ChatMessage[],
  schema: { name: string; schema: unknown },
  options: CallOptions = {},
  maxAttempts = 3,
): Promise<{ data: T; model: string; requestId: string }> {
  let lastFailure: RouterFailure | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { userId, bundleId, ...rest } = options;
      const result = await ai.completeJson<T>(taskClass, messages, schema, {
        ...rest,
        ...(userId ? { userId } : {}),
        ...(bundleId ? { engagementRef: bundleId } : {}),
      });
      return { data: result.data, model: result.model, requestId: result.requestId };
    } catch (err) {
      const failure = classifyFailure(err);
      lastFailure = failure;
      if (failure.kind === 'retry' && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, Math.min(failure.afterSeconds, 60) * 1000));
        continue;
      }
      throw new RouterCallError(failure);
    }
  }
  throw new RouterCallError(lastFailure ?? { kind: 'park', code: 'unknown', message: 'exhausted' });
}

export class RouterCallError extends Error {
  readonly failure: RouterFailure;

  constructor(failure: RouterFailure) {
    super(`router ${failure.kind}: ${failure.code} — ${failure.message}`);
    this.name = 'RouterCallError';
    this.failure = failure;
  }
}

// ── startup assertions (P3, P14) ─────────────────────────────────────────────

export interface StartupReport {
  registered: { key: string; created: boolean; sensitivity: string }[];
  warnings: string[];
}

/**
 * Whether the router answered at startup. The UI reads this to say "the Router is down"
 * rather than reporting a bundle as failed (§3).
 */
let routerReachable = false;

export function setRouterReachable(value: boolean): void {
  routerReachable = value;
}

export function isRouterReachable(): boolean {
  return routerReachable;
}

/**
 * Keep trying to register in the background after a failed startup.
 *
 * Without this, a router that comes back five minutes after an app restart would stay
 * unregistered until someone noticed and restarted the app again — during filing season,
 * that is a silent halt rather than a recovery.
 */
export function retryRegistrationInBackground(intervalMs = 60_000): void {
  const attempt = async (): Promise<void> => {
    try {
      const report = await registerAndVerify();
      setRouterReachable(true);
      console.log('[router] registration recovered');
      for (const warning of report.warnings) console.warn(`[router] WARNING ${warning}`);
    } catch {
      setTimeout(() => void attempt(), intervalMs).unref();
    }
  };
  setTimeout(() => void attempt(), intervalMs).unref();
}

/**
 * Register our classes and check what came back.
 *
 * Two distinct failures are possible and they mean different things:
 *  - a class is pinned `local_only` when we expect cloud → provisioning never did the
 *    firm-admin widening, and the app would silently run entirely on local models;
 *  - the router cannot be reached at all → nothing can proceed.
 */
export async function registerAndVerify(): Promise<StartupReport> {
  const { registered } = await ai.registerTaskClasses({
    app: APP_NAME,
    version: APP_VERSION,
    classes: DECLARATIONS,
  });

  const warnings: string[] = [];
  const expected = env.ROUTER_EXPECTED_SENSITIVITY;

  for (const key of Object.values(TASK_CLASS)) {
    const row = registered.find((r) => r.key === key);
    if (!row) {
      warnings.push(`task class ${key} was not acknowledged by the router`);
      continue;
    }
    if (row.sensitivity !== expected) {
      warnings.push(
        `task class ${key} is '${row.sensitivity}' but this deployment expects '${expected}'. ` +
          (row.sensitivity === 'local_only'
            ? 'Registration always creates local_only; a firm admin must widen it in the router admin UI. ' +
              'Until then this class runs on local models only.'
            : ''),
      );
    }
  }

  return { registered, warnings };
}

/**
 * §11: assert the router pins these task classes to US regions, and refuse to start if not.
 *
 * **This cannot currently succeed.** As of router v0.0.24 there is no region concept — no
 * region column on policy, no enforcement at routing time, and no policy-reporting
 * endpoint to ask. The probe below is written against the endpoint shape P14 expects so
 * that it starts working the moment the router grows it (QUESTIONS.md Q11).
 *
 * Fails closed by design. Because these classes are `cloud_deidentified` and the router's
 * scrubber cannot scrub image parts, this assertion is the only control keeping taxpayer
 * page images inside US inference. Do not soften it to get a deployment up.
 */
export async function assertUsRegionPinning(): Promise<void> {
  if (!env.ROUTER_REQUIRE_US_REGION) {
    console.warn(
      '[startup] ROUTER_REQUIRE_US_REGION=false — region pinning is NOT being enforced. ' +
        'Acceptable in development only; never for live client data (§11).',
    );
    return;
  }

  interface RegionPolicyReport {
    classes?: { key: string; regions?: string[] }[];
  }

  const url = new URL('/v1/policy/regions', env.VIBE_AI_ROUTER_URL);
  let payload: RegionPolicyReport | null = null;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.VIBE_AI_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) payload = (await res.json()) as RegionPolicyReport;
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new Error(
      'Refusing to start: the router does not expose region pinning.\n' +
        `  Probed ${url.href} and got no usable policy report.\n` +
        '  §11 requires US-region pinning for v1040_page_classify, v1040_layout and\n' +
        '  v1040_field_extract before taxpayer data may be processed. As of router\n' +
        '  v0.0.24 this capability does not exist — see QUESTIONS.md Q11.\n' +
        '  Set ROUTER_REQUIRE_US_REGION=false for development ONLY.',
    );
  }

  const offenders = Object.values(TASK_CLASS).filter((key) => {
    const entry = payload.classes?.find((c) => c.key === key);
    const regions = entry?.regions ?? [];
    return regions.length === 0 || !regions.every((r) => r.toLowerCase().startsWith('us'));
  });

  if (offenders.length) {
    throw new Error(
      `Refusing to start: task classes are not US-pinned: ${offenders.join(', ')} (§11).`,
    );
  }
}
