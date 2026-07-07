/**
 * Durable persistence for Ishu on ephemeral-disk platforms (Cloudflare
 * Containers, Fly Machines without volumes, etc.).
 *
 * The agent persists sessions, memory, the thread map, feedback, the audit
 * log, and response artifacts to the local filesystem. On a platform where the
 * disk is wiped on every restart, that continuity would be lost. This module
 * mirrors those two directories (sessions + bucket) to an S3-compatible object
 * store (Cloudflare R2) so state survives restarts:
 *
 *   - restoreFromR2()  downloads every object back to local disk on boot,
 *     before the bucket server or Slack connection starts.
 *   - startR2Sync()    uploads files changed since the last pass on an interval.
 *   - flushR2()        performs a final synchronous upload on shutdown.
 *
 * Everything here is a no-op unless R2 is fully configured (see cfg.r2.enabled),
 * so local and Docker deployments behave exactly as before.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { cfg } from "../config.js";

interface SyncRoot {
  dir: string;
  keyPrefix: string;
}

let client: S3Client | undefined;
let timer: NodeJS.Timeout | undefined;
let syncing = false;
// Absolute local path -> mtimeMs of the version we last uploaded, so we only
// re-upload files that actually changed since the previous pass.
const lastSynced = new Map<string, number>();

function getRoots(): SyncRoot[] {
  const prefix = cfg.r2.prefix;
  return [
    { dir: resolve(cfg.storage.bucketDir), keyPrefix: `${prefix}/bucket` },
    { dir: resolve(cfg.agent.sessionsDir), keyPrefix: `${prefix}/sessions` },
  ];
}

function getClient(): S3Client {
  if (!client) {
    const endpoint =
      cfg.r2.endpoint || `https://${cfg.r2.accountId}.r2.cloudflarestorage.com`;
    client = new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.r2.accessKeyId,
        secretAccessKey: cfg.r2.secretAccessKey,
      },
    });
  }
  return client;
}

function toKey(root: SyncRoot, absPath: string): string {
  const rel = relative(root.dir, absPath).split("\\").join("/");
  return `${root.keyPrefix}/${rel}`;
}

function toLocalPath(root: SyncRoot, key: string): string {
  const rel = key.slice(root.keyPrefix.length + 1);
  return join(root.dir, rel);
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await getClient().send(
      new ListObjectsV2Command({
        Bucket: cfg.r2.bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function uploadFile(root: SyncRoot, absPath: string): Promise<void> {
  const body = readFileSync(absPath);
  await getClient().send(
    new PutObjectCommand({
      Bucket: cfg.r2.bucket,
      Key: toKey(root, absPath),
      Body: body,
    }),
  );
  lastSynced.set(absPath, statSync(absPath).mtimeMs);
}

/**
 * Download all persisted state from R2 back onto local disk. Call once at
 * startup, before the bucket server or Slack connection comes up, so restored
 * sessions/artifacts are immediately served and recalled.
 */
export async function restoreFromR2(): Promise<void> {
  if (!cfg.r2.enabled) return;
  let restored = 0;
  try {
    for (const root of getRoots()) {
      const keys = await listKeys(root.keyPrefix);
      for (const key of keys) {
        const res = await getClient().send(
          new GetObjectCommand({ Bucket: cfg.r2.bucket, Key: key }),
        );
        if (!res.Body) continue;
        const bytes = await res.Body.transformToByteArray();
        const target = toLocalPath(root, key);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, Buffer.from(bytes));
        // Align local mtime with the object's so the first sync pass does not
        // needlessly re-upload everything we just downloaded.
        if (res.LastModified) {
          try {
            utimesSync(target, res.LastModified, res.LastModified);
          } catch {
            // best-effort; ignore
          }
        }
        lastSynced.set(target, statSync(target).mtimeMs);
        restored++;
      }
    }
    console.log(`R2: restored ${restored} object(s) from bucket "${cfg.r2.bucket}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`R2: restore failed (continuing with local state): ${message}`);
  }
}

/** Upload every file changed since the last pass. Safe to call repeatedly. */
export async function syncToR2(): Promise<void> {
  if (!cfg.r2.enabled || syncing) return;
  syncing = true;
  let uploaded = 0;
  try {
    for (const root of getRoots()) {
      for (const absPath of walkFiles(root.dir)) {
        const mtime = statSync(absPath).mtimeMs;
        if (lastSynced.get(absPath) === mtime) continue;
        try {
          await uploadFile(root, absPath);
          uploaded++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`R2: upload failed for ${absPath}: ${message}`);
        }
      }
    }
    if (uploaded > 0) console.log(`R2: synced ${uploaded} changed file(s)`);
  } finally {
    syncing = false;
  }
}

/** Begin the periodic background sync. No-op if R2 is not configured. */
export function startR2Sync(): void {
  if (!cfg.r2.enabled || timer) return;
  timer = setInterval(() => {
    void syncToR2();
  }, cfg.r2.syncIntervalMs);
  // Do not keep the event loop alive solely for the sync timer.
  timer.unref?.();
  console.log(
    `R2: durable sync enabled (bucket "${cfg.r2.bucket}", every ${cfg.r2.syncIntervalMs}ms)`,
  );
}

/** Stop the interval and perform one final upload. Call on shutdown. */
export async function flushR2(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (!cfg.r2.enabled) return;
  // Wait out an in-flight pass, then do a final one so nothing is lost.
  while (syncing) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await syncToR2();
}
