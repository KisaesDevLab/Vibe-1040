/**
 * Email and SMS delivery.
 *
 * Both channels carry one-time codes and password-reset links, so the content rules are
 * strict: **no taxpayer data, no client names, no bundle contents ever leave through here.**
 * These messages say that someone is signing in and nothing about what they will see.
 *
 * SMS goes over a Twilio-compatible REST endpoint using `fetch` — no SDK, consistent with
 * how the rest of this repo treats external services.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { db } from '../db/client.ts';
import { notificationLog } from '../db/schema.ts';
import { setting } from '../settings/store.ts';

export type Channel = 'email' | 'sms';
export type Purpose = 'mfa' | 'password_reset' | 'phone_verify';

export interface SendResult {
  ok: boolean;
  error?: string;
}

// ── email ────────────────────────────────────────────────────────────────────

let transporter: Transporter | null = null;
let transporterKey = '';

async function mailer(): Promise<Transporter> {
  const host = await setting<string>('email.host');
  const port = await setting<number>('email.port');
  const secure = await setting<boolean>('email.secure');
  const username = await setting<string>('email.username');
  const password = await setting<string>('email.password');

  // Rebuild when configuration changes rather than holding a stale connection pool.
  const key = `${host}:${port}:${secure}:${username}:${password ? 'pw' : 'nopw'}`;
  if (transporter && transporterKey === key) return transporter;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(username ? { auth: { user: username, pass: password } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  transporterKey = key;
  return transporter;
}

export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  if (!(await setting<boolean>('email.enabled'))) {
    return { ok: false, error: 'email delivery is disabled in Admin → Settings' };
  }
  const from = await setting<string>('email.from');
  if (!from) return { ok: false, error: 'no From address configured' };

  try {
    await (await mailer()).sendMail({ from, to, subject, text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Prove the configuration works before anyone depends on it at a login prompt. */
export async function verifyEmail(): Promise<SendResult> {
  if (!(await setting<boolean>('email.enabled'))) {
    return { ok: false, error: 'email delivery is disabled' };
  }
  try {
    await (await mailer()).verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── sms ──────────────────────────────────────────────────────────────────────

/** E.164, loosely — enough to catch a transposed digit or a missing country code. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  const bare = digits.replace(/\D/g, '');
  // A bare 10-digit number is assumed North American, which is the whole user base here.
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  return null;
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  if (!(await setting<boolean>('sms.enabled'))) {
    return { ok: false, error: 'SMS delivery is disabled in Admin → Settings' };
  }

  const accountSid = await setting<string>('sms.account_sid');
  const authToken = await setting<string>('sms.auth_token');
  const from = await setting<string>('sms.from_number');
  const baseUrl = (await setting<string>('sms.base_url')) || 'https://api.twilio.com';

  if (!accountSid || !authToken || !from) {
    return { ok: false, error: 'SMS is enabled but incompletely configured' };
  }

  const normalized = normalizePhone(to);
  if (!normalized) return { ok: false, error: `not a usable phone number: ${to}` };

  const url = `${baseUrl.replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: normalized, From: from, Body: body }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = await res.text();
      // Twilio returns a useful message; truncate so a provider error cannot flood the log.
      return { ok: false, error: `${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── shared ───────────────────────────────────────────────────────────────────

/** Redacted for storage and display — never log a full address or number. */
export function redact(channel: Channel, destination: string): string {
  if (channel === 'email') {
    const [local, domain] = destination.split('@');
    if (!local || !domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `***-***-${destination.slice(-4)}`;
}

export async function recordDelivery(entry: {
  userId: string | null;
  channel: Channel;
  purpose: Purpose;
  destination: string;
  result: SendResult;
}): Promise<void> {
  await db.insert(notificationLog).values({
    userId: entry.userId,
    channel: entry.channel,
    purpose: entry.purpose,
    destination: redact(entry.channel, entry.destination),
    succeeded: entry.result.ok,
    error: entry.result.error ?? null,
  });
}
