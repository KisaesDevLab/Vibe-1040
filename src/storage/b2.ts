/**
 * Backblaze B2 driver (P1, Q6) — optional, following the Filer pattern. Native B2 API over
 * `fetch`; no SDK, no signing library.
 *
 * Blobs are already AES-256-GCM encrypted by the layer above before they reach here, so B2
 * only ever holds ciphertext. That is deliberate: it keeps the §11 encryption-at-rest claim
 * true without depending on the provider's own encryption story.
 */
import { createHash } from 'node:crypto';
import { env } from '../config/env.ts';
import { BlobNotFoundError, type BlobDriver } from './types.ts';

interface AuthState {
  apiUrl: string;
  downloadUrl: string;
  token: string;
  expiresAt: number;
}

export class B2Driver implements BlobDriver {
  readonly name = 'b2' as const;
  private auth: AuthState | null = null;

  private get bucket(): string {
    const b = env.B2_BUCKET;
    if (!b) throw new Error('B2_BUCKET is not configured');
    return b;
  }

  /** B2 auth tokens last 24h; refresh an hour early rather than handling a mid-upload 401. */
  private async authorize(): Promise<AuthState> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;

    const basic = Buffer.from(`${env.B2_KEY_ID}:${env.B2_APPLICATION_KEY}`).toString('base64');
    const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) throw new Error(`b2 authorize failed: ${res.status} ${await res.text()}`);

    const body = (await res.json()) as {
      apiInfo: { storageApi: { apiUrl: string; downloadUrl: string } };
      authorizationToken: string;
    };
    this.auth = {
      apiUrl: body.apiInfo.storageApi.apiUrl,
      downloadUrl: body.apiInfo.storageApi.downloadUrl,
      token: body.authorizationToken,
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
    };
    return this.auth;
  }

  private async bucketId(auth: AuthState): Promise<string> {
    const res = await fetch(
      `${auth.apiUrl}/b2api/v3/b2_list_buckets?accountId=${encodeURIComponent(env.B2_KEY_ID!)}&bucketName=${encodeURIComponent(this.bucket)}`,
      { headers: { Authorization: auth.token } },
    );
    if (!res.ok) throw new Error(`b2 list_buckets failed: ${res.status}`);
    const body = (await res.json()) as { buckets: { bucketId: string }[] };
    const id = body.buckets[0]?.bucketId;
    if (!id) throw new Error(`b2 bucket not found: ${this.bucket}`);
    return id;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const auth = await this.authorize();
    const bucketId = await this.bucketId(auth);

    const urlRes = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url?bucketId=${bucketId}`, {
      headers: { Authorization: auth.token },
    });
    if (!urlRes.ok) throw new Error(`b2 get_upload_url failed: ${urlRes.status}`);
    const { uploadUrl, authorizationToken } = (await urlRes.json()) as {
      uploadUrl: string;
      authorizationToken: string;
    };

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: authorizationToken,
        'X-Bz-File-Name': encodeURIComponent(key),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
        'X-Bz-Content-Sha1': createHash('sha1').update(bytes).digest('hex'),
      },
      body: new Uint8Array(bytes),
    });
    if (!res.ok) throw new Error(`b2 upload failed: ${res.status} ${await res.text()}`);
  }

  async get(key: string): Promise<Buffer> {
    const auth = await this.authorize();
    const res = await fetch(
      `${auth.downloadUrl}/file/${encodeURIComponent(this.bucket)}/${encodeURIComponent(key)}`,
      { headers: { Authorization: auth.token } },
    );
    if (res.status === 404) throw new BlobNotFoundError(key);
    if (!res.ok) throw new Error(`b2 download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * B2 versions files, so a delete is per-version. Hide every version of the key — a
   * retention purge (§11, P13) that left an old version behind would not be a disposal.
   */
  async delete(key: string): Promise<void> {
    const auth = await this.authorize();
    const bucketId = await this.bucketId(auth);
    const listRes = await fetch(
      `${auth.apiUrl}/b2api/v3/b2_list_file_versions?bucketId=${bucketId}&startFileName=${encodeURIComponent(key)}&maxFileCount=1000`,
      { headers: { Authorization: auth.token } },
    );
    if (!listRes.ok) throw new Error(`b2 list_file_versions failed: ${listRes.status}`);
    const body = (await listRes.json()) as { files: { fileId: string; fileName: string }[] };

    for (const file of body.files.filter((f) => f.fileName === key)) {
      const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
        method: 'POST',
        headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.fileId, fileName: key }),
      });
      if (!res.ok) throw new Error(`b2 delete_file_version failed: ${res.status}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.get(key);
      return true;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return false;
      throw err;
    }
  }
}
