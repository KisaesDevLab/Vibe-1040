/**
 * Blob storage abstraction (P1). The driver swaps by config with no code change; the
 * encryption layer sits above it so "encrypted at rest" (§11) holds for every backend, not
 * just the local volume.
 */
export interface BlobDriver {
  readonly name: 'local' | 'b2';
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export class BlobNotFoundError extends Error {
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = 'BlobNotFoundError';
  }
}
