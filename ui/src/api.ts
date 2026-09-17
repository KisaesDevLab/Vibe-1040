import type {
  AuditRow,
  Bundle,
  CheckRow,
  DocumentRow,
  EnvSetting,
  FactorState,
  FieldRow,
  PageRow,
  BundleProgress,
  QueueFailure,
  RouterJobRow,
  WorksheetRow,
  SettingRow,
  SpanRow,
  UserRow,
  WorksheetLine,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one. Sending `Content-Type: application/json`
  // on a bodyless POST makes Fastify reject the request outright with "Body cannot be
  // empty when content-type is set to 'application/json'", which is what every POST that
  // carries no payload was doing: enrolling an authenticator, sending a code, signing out,
  // resetting a factor, running retention, generating a worksheet.
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.message ?? body.error ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<{ id: string; email: string; displayName: string; role: string }>('/api/me'),

  login: (email: string, password: string) =>
    request<{ mfaRequired: boolean; method: 'totp' | 'email' | 'sms'; enrolled: boolean; needsTotpEnrolment: boolean }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
    ),

  factor: () => request<FactorState>('/api/auth/factor'),

  enrollMfa: () =>
    request<{ secret: string; uri: string; account: string; issuer: string }>('/api/auth/totp/enroll', {
      method: 'POST',
    }),

  verifyMfa: (token: string) =>
    request<{ ok: boolean }>('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ token }) }),

  /** Email/SMS second factor. */
  sendCode: () =>
    request<{ ok: boolean; destination: string; channel: 'email' | 'sms' }>('/api/auth/mfa/send', { method: 'POST' }),

  verifyCode: (code: string) =>
    request<{ ok: boolean }>('/api/auth/mfa/verify-code', { method: 'POST', body: JSON.stringify({ code }) }),

  forgotPassword: (email: string) =>
    request<{ accepted: boolean; message: string }>('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (email: string, code: string, password: string) =>
    request<{ ok: boolean }>('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // ── admin ──────────────────────────────────────────────────────────────────
  adminSettings: () =>
    request<{ settings: SettingRow[]; environment: EnvSetting[] }>('/api/admin/settings'),

  updateSettings: (updates: { key: string; value: unknown }[]) =>
    request<{ ok: boolean; settings: SettingRow[] }>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify({ updates }),
    }),

  testEmail: (to?: string) =>
    request<{ ok: boolean }>('/api/admin/settings/test-email', {
      method: 'POST',
      body: JSON.stringify(to ? { to } : {}),
    }),

  testSms: (to: string) =>
    request<{ ok: boolean }>('/api/admin/settings/test-sms', { method: 'POST', body: JSON.stringify({ to }) }),

  adminUsers: () => request<UserRow[]>('/api/admin/users'),

  createUser: (body: Record<string, string>) =>
    request<{ id: string }>('/api/admin/users', { method: 'POST', body: JSON.stringify(body) }),

  updateUser: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  resetMfa: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}/reset-mfa`, { method: 'POST' }),

  auditLog: (q: { action?: string; from?: string; to?: string; limit: number; offset: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== '' && v !== undefined) params.set(k, String(v));
    return request<{ rows: AuditRow[]; total: number }>(`/api/admin/audit?${params}`);
  },

  auditActions: () => request<string[]>('/api/admin/audit/actions'),

  retentionForecast: () => request<{ rastersDue: number; sourcesDue: number }>('/api/admin/retention'),

  runRetention: () =>
    request<Record<string, unknown>>('/api/admin/retention/run', { method: 'POST' }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  bundles: (filter: { q?: string; status?: string; taxYear?: number } = {}) => {
    const params = new URLSearchParams();
    if (filter.q) params.set('q', filter.q);
    if (filter.status) params.set('status', filter.status);
    if (filter.taxYear) params.set('taxYear', String(filter.taxYear));
    const qs = params.toString();
    return request<Bundle[]>(`/api/bundles${qs ? `?${qs}` : ''}`);
  },

  /** Irreversible. `confirmLabel` must equal the bundle's label exactly. */
  deleteBundle: (id: string, confirmLabel: string) =>
    request<{ ok: boolean; blobsDeleted: number; errors: { key: string; message: string }[] }>(
      `/api/bundles/${id}`,
      { method: 'DELETE', body: JSON.stringify({ confirmLabel }) },
    ),

  bundle: (id: string) =>
    request<{
      bundle: Bundle;
      documents: DocumentRow[];
      checks: CheckRow[];
      taxpayers: { taxpayerId: string; displayName: string | null; tinLast4: string; role: string; proposed: boolean }[];
      routerDown: boolean;
      parkedJobs: number;
      failedJobs: number;
      routerJobs: RouterJobRow[];
      progress: BundleProgress;
      queueFailures: QueueFailure[];
      worksheets: WorksheetRow[];
      blocking: { id: string; checkKey: string; message: string }[];
    }>(`/api/bundles/${id}`),

  document: (id: string) =>
    request<{ document: DocumentRow; pages: PageRow[]; fields: FieldRow[]; spans: SpanRow[] }>(
      `/api/documents/${id}`,
    ),

  correctField: (
    fieldId: string,
    body: { cents?: number | null; text?: string | null; bool?: boolean | null; setToNull?: boolean; note?: string },
  ) => request<{ ok: boolean }>(`/api/fields/${fieldId}/correct`, { method: 'POST', body: JSON.stringify(body) }),

  correctDocumentYear: (documentId: string, taxYear: number | null) =>
    request<{ ok: boolean; taxYear: number | null }>(`/api/documents/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ taxYear }),
    }),

  disposition: (checkId: string, kind: string, note: string) =>
    request<{ ok: boolean; remainingBlocking: number }>(`/api/checks/${checkId}/disposition`, {
      method: 'POST',
      body: JSON.stringify({ kind, note }),
    }),

  /**
   * Re-run the pipeline. 'reconcile' costs nothing, 'extract' re-binds from stored spans,
   * 'classify' starts again from the page images and is the only one that pays for vision.
   * A 409 means reclassifying would discard reviewer corrections; re-send acknowledged.
   */
  buildSortedPdf: (bundleId: string) =>
    request<{ ok: boolean; pageCount: number; bookmarks: number }>(`/api/bundles/${bundleId}/sorted-pdf`, { method: 'POST' }),

  requeueRouterJobs: (bundleId: string) =>
    request<{ ok: boolean; requeued: number; classify: boolean; pages: number; documents: number }>(
      `/api/bundles/${bundleId}/router-jobs/requeue`,
      { method: 'POST' },
    ),

  reprocess: async (
    bundleId: string,
    from: 'reconcile' | 'extract' | 'classify',
    acknowledgeDiscardsCorrections = false,
  ): Promise<{ ok: boolean }> => {
    const body = JSON.stringify({ from, acknowledgeDiscardsCorrections });
    const res = await fetch(`/api/bundles/${bundleId}/reprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      credentials: 'same-origin',
    });
    const parsed = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      corrections?: number;
    };
    if (res.status === 409 && parsed.error === 'would_discard_corrections') {
      if (!window.confirm(`${parsed.message}

Proceed and discard them?`)) return { ok: false };
      return api.reprocess(bundleId, from, true);
    }
    if (!res.ok) throw new Error(parsed.message ?? parsed.error ?? `reprocess failed: ${res.status}`);
    return parsed as { ok: boolean };
  },

  confirmIdentity: (bundleId: string, taxYear: number, taxpayers: { taxpayerId: string; role: string }[]) =>
    request<{ ok: boolean; pagesQueued: number }>(`/api/bundles/${bundleId}/identity/confirm`, {
      method: 'POST',
      body: JSON.stringify({ taxYear, taxpayers }),
    }),

  worksheetPreview: (bundleId: string) =>
    request<{
      model: { taxYear: number; mappingVersion: string; lines: WorksheetLine[] };
      documentLabels: Record<string, string>;
      softAnnotations: { checkKey: string; message: string }[];
      blocking: { id: string; checkKey: string; message: string }[];
    }>(`/api/bundles/${bundleId}/worksheet/preview`),

  generateWorksheet: (bundleId: string) =>
    request<{ worksheetId: string; lines: number }>(`/api/bundles/${bundleId}/worksheet`, { method: 'POST' }),

  upload: async (label: string, files: FileList): Promise<{ bundleId: string }> => {
    const form = new FormData();
    form.append('label', label);
    for (const file of Array.from(files)) form.append('files', file);
    const res = await fetch('/api/bundles', { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    return res.json() as Promise<{ bundleId: string }>;
  },

  /** One bundle per file. 207 means some ingested and some did not, which is not an error. */
  uploadBulk: async (
    files: FileList,
  ): Promise<{ bundles: { bundleId: string; label: string }[]; rejected: { filename: string; reason: string }[] }> => {
    const form = new FormData();
    for (const file of Array.from(files)) form.append('files', file);
    const res = await fetch('/api/bundles/bulk', { method: 'POST', body: form, credentials: 'same-origin' });
    if (!res.ok && res.status !== 207) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `bulk upload failed: ${res.status}`);
    }
    return res.json() as Promise<{
      bundles: { bundleId: string; label: string }[];
      rejected: { filename: string; reason: string }[];
    }>;
  },

  renameBundle: (id: string, label: string) =>
    request<{ ok: boolean; label: string }>(`/api/bundles/${id}/label`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),
};

export function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `(${s})` : s;
}
