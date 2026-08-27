/**
 * The blob store the app actually uses: a driver chosen by config, wrapped in AES-256-GCM.
 *
 * Encryption lives here rather than in the drivers so §11's encryption-at-rest obligation
 * is a property of the store, not of whichever backend happens to be selected. Swapping
 * `STORAGE_DRIVER` cannot accidentally downgrade it.
 *
 * Envelope: [1-byte version][12-byte iv][16-byte tag][ciphertext]
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { env, secrets } from '../config/env.ts';
import { B2Driver } from './b2.ts';
import { LocalDriver } from './local.ts';
import type { BlobDriver } from './types.ts';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

export function seal(plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', secrets.storageKey, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer): Buffer {
  const version = sealed[0];
  if (version !== VERSION) throw new Error(`unknown blob envelope version: ${String(version)}`);
  const iv = sealed.subarray(1, 1 + IV_LEN);
  const tag = sealed.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const body = sealed.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', secrets.storageKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

function makeDriver(): BlobDriver {
  return env.STORAGE_DRIVER === 'b2' ? new B2Driver() : new LocalDriver();
}

/**
 * Note on style: fields are declared and assigned explicitly rather than using TypeScript
 * parameter properties. Node's `--experimental-strip-types` (how `npm run dev`, `worker`,
 * and the migration scripts run) refuses parameter properties outright, so they would work
 * in the built image and fail in development.
 */
export class BlobStore {
  private readonly driver: BlobDriver;

  constructor(driver: BlobDriver = makeDriver()) {
    this.driver = driver;
  }

  get driverName(): string {
    return this.driver.name;
  }

  async put(key: string, plaintext: Buffer): Promise<void> {
    await this.driver.put(key, seal(plaintext));
  }

  async get(key: string): Promise<Buffer> {
    return open(await this.driver.get(key));
  }

  async delete(key: string): Promise<void> {
    await this.driver.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.driver.exists(key);
  }
}

export const blobs = new BlobStore();

/** Key layout. Rasters are namespaced so a retention sweep can reason about them alone. */
export const keys = {
  source: (bundleId: string, fileId: string): string => `bundles/${bundleId}/source/${fileId}`,
  raster: (bundleId: string, pageId: string): string => `bundles/${bundleId}/raster/${pageId}.jpg`,
  worksheetXlsx: (bundleId: string, worksheetId: string): string =>
    `bundles/${bundleId}/worksheet/${worksheetId}.xlsx`,
  worksheetPdf: (bundleId: string, worksheetId: string): string =>
    `bundles/${bundleId}/worksheet/${worksheetId}.pdf`,
  newId: (): string => randomUUID(),
} as const;
