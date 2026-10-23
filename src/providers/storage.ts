import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Object storage adapter. The private store holds applicant documents, generated PDFs and
 * exports and is never publicly readable; access is through short-lived signed URLs issued
 * after an authorization check, or streamed through the API. Object keys are random and never
 * contain original file names.
 */

export interface UploadTarget {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  /** Direct-to-bucket upload URL, or null when uploads go through the API. */
  createUploadUrl(key: string, options: { contentType: string; expiresInSeconds: number }): Promise<UploadTarget | null>;
  /** Short-lived download URL, or null when downloads are streamed through the API. */
  createDownloadUrl(key: string, options: { filename: string; contentType: string; expiresInSeconds: number }): Promise<string | null>;
  /** Public URL for objects in a public bucket. */
  publicUrl?(key: string): string | null;
}

const contentDisposition = (filename: string) => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};
export { contentDisposition };

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { endpoint?: string; region: string; accessKeyId: string; secretAccessKey: string },
    private readonly publicBaseUrl?: string
  ) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey }
    });
  }

  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await result.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async head(key: string) {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: result.ContentLength ?? 0 };
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createUploadUrl(key: string, options: { contentType: string; expiresInSeconds: number }) {
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: options.contentType }), {
      expiresIn: options.expiresInSeconds
    });
    return {
      method: 'PUT' as const,
      url,
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000).toISOString()
    };
  }

  async createDownloadUrl(key: string, options: { filename: string; contentType: string; expiresInSeconds: number }) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(options.filename),
        ResponseContentType: options.contentType
      }),
      { expiresIn: options.expiresInSeconds }
    );
  }

  publicUrl(key: string) {
    return this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${key}` : null;
  }
}

/** Local filesystem storage for development. Uploads and downloads go through the API. */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string, private readonly publicBaseUrl?: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    if (!/^[a-z0-9][a-z0-9/_-]{0,250}$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async head(key: string) {
    try {
      const info = await stat(this.path(key));
      return { size: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }

  async createUploadUrl() {
    return null;
  }

  async createDownloadUrl() {
    return null;
  }

  publicUrl(key: string) {
    return this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, '')}/${key}` : null;
  }
}

export class MemoryStorageProvider implements StorageProvider {
  readonly name = 'memory';
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType });
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
  async head(key: string) {
    const item = this.objects.get(key);
    return item ? { size: item.body.length } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async createUploadUrl() {
    return null;
  }
  async createDownloadUrl() {
    return null;
  }
  publicUrl(key: string) {
    return `https://media.example.invalid/${key}`;
  }
}
