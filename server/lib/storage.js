// Object storage abstraction — Cloudflare R2 with a local-disk fallback.
//
// Menu photos (and any future uploaded asset) go through here. When the full
// set of R2_* env vars is present we write to R2 (durable, S3-compatible,
// served from a public custom domain). Otherwise we fall back to local disk
// under data/uploads/, served by the existing `/uploads` static route in
// server/index.js — the same mechanism logos/receipts already use.
//
// This lets the feature work locally and on a fresh deploy BEFORE R2 is
// provisioned; flipping to durable R2 is purely an env change, no code edit.
// (Railway's filesystem is ephemeral, so disk is a dev/interim backend only —
// provision R2 before relying on menu photos surviving a redeploy.)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
// Public host for read URLs, e.g. img.desktop.kitchen (no scheme, no trailing slash).
const R2_PUBLIC_HOST = (process.env.R2_PUBLIC_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

const useR2 = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_BUCKET &&
  R2_PUBLIC_HOST
);

// Disk fallback root. Keys are stored as-is beneath it and served at /uploads/<key>.
const DISK_ROOT = path.join(__dirname, '../../data/uploads');

let _client = null;
async function getClient() {
  if (_client) return _client;
  // Lazy import so the app doesn't hard-require @aws-sdk/client-s3 when running
  // on the disk backend (e.g. local dev before the dependency is installed).
  const { S3Client } = await import('@aws-sdk/client-s3');
  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

/** Which backend is active: 'r2' when fully configured, else 'disk'. */
export function storageBackend() {
  return useR2 ? 'r2' : 'disk';
}

// Reject anything that could escape the intended key space (path traversal,
// absolute paths). Callers build keys from a server-generated uuid + the
// tenant id, but we defend here too.
function assertSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
    throw new Error('Invalid storage key');
  }
  if (key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new Error('Invalid storage key');
  }
}

/**
 * Store an object and return its public read URL.
 * @param {string} key  e.g. "<tenant>/menu/<uuid>/card.webp"
 * @param {Buffer} buffer
 * @param {string} contentType
 */
export async function putObject(key, buffer, contentType = 'application/octet-stream') {
  assertSafeKey(key);

  if (useR2) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // Immutable: keys embed a uuid, so content never changes under a key.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `https://${R2_PUBLIC_HOST}/${key}`;
  }

  // Disk fallback.
  const filePath = path.join(DISK_ROOT, key);
  // Defense-in-depth: ensure the resolved path stays under DISK_ROOT.
  if (!path.resolve(filePath).startsWith(path.resolve(DISK_ROOT) + path.sep)) {
    throw new Error('Resolved storage path escapes upload root');
  }
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/${key}`;
}

/**
 * Delete every object under a key prefix (used to remove all variants of one
 * photo at once, e.g. "<tenant>/menu/<uuid>"). Returns the number removed
 * (best-effort; 1 for the disk backend's directory removal).
 */
export async function deletePrefix(prefix) {
  assertSafeKey(prefix);

  if (useR2) {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const client = await getClient();
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix }),
    );
    const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: objects } }),
      );
    }
    return objects.length;
  }

  const dir = path.join(DISK_ROOT, prefix);
  if (!path.resolve(dir).startsWith(path.resolve(DISK_ROOT) + path.sep)) {
    throw new Error('Resolved storage path escapes upload root');
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
  return 1;
}
