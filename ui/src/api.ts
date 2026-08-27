import type { Bundle, CheckRow, DocumentRow, FieldRow, PageRow, SpanRow, WorksheetLine } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
    request<{ mfaRequired: boolean; enrolled: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  enrollMfa: () => request<{ secret: string; uri: string }>('/api/auth/mfa/enroll', { method: 'POST' }),

  verifyMfa: (token: string) =>
    request<{ ok: boolean }>('/api/auth/mfa/verify', { method: 'POST', body: JSON.stringify({ token }) }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  bundles: () => request<Bundle[]>('/api/bundles'),

  bundle: (id: string) =>
    request<{
      bundle: Bundle;
      documents: DocumentRow[];
      checks: CheckRow[];
      taxpayers: { taxpayerId: string; displayName: string | null; tinLast4: string; role: string; proposed: boolean }[];
      routerDown: boolean;
      parkedJobs: number;
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

  disposition: (checkId: string, kind: string, note: string) =>
    request<{ ok: boolean; remainingBlocking: number }>(`/api/checks/${checkId}/disposition`, {
      method: 'POST',
      body: JSON.stringify({ kind, note }),
    }),

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
};

export function formatCents(cents: number | null): string {
  if (cents === null) return '—';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `(${s})` : s;
}
