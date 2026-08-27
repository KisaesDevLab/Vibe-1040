import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { env } from '../config/env.ts';
import { BlobNotFoundError, type BlobDriver } from './types.ts';

/**
 * Local encrypted volume — the default backend (§12, Q6).
 *
 * Keys are fanned into two levels of subdirectory so a filing season's worth of page
 * images does not land in one directory.
 */
export class LocalDriver implements BlobDriver {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(root: string = env.STORAGE_LOCAL_PATH) {
    this.root = resolve(root);
  }

  /** Keys come from our own code, but a traversal check is cheap insurance. */
  private path(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..')) {
      throw new Error(`illegal blob key: ${key}`);
    }
    const full = resolve(join(this.root, key));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`blob key escapes storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a torn blob behind.
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(tmp, target);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BlobNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}
