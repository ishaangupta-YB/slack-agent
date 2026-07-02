import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uploadFiles, downloadFile, HUB_URL } from "@huggingface/hub";
import { cfg } from "../config.js";

export interface Bucket {
  write(path: string, content: string | Buffer, contentType?: string): Promise<void>;
  read(path: string): Promise<Buffer>;
  readUrl(path: string): string;
}

class LocalBucket implements Bucket {
  private baseDir: string;
  private publicUrl: string;

  constructor(baseDir: string, publicUrl?: string) {
    this.baseDir = baseDir;
    this.publicUrl = publicUrl?.replace(/\/$/, "") ?? "";
  }

  async write(path: string, content: string | Buffer, _contentType?: string): Promise<void> {
    const target = join(this.baseDir, path);
    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(target, content);
  }

  async read(path: string): Promise<Buffer> {
    const target = join(this.baseDir, path);
    if (!existsSync(target)) {
      throw new Error(`Bucket object not found: ${path}`);
    }
    return readFileSync(target);
  }

  readUrl(path: string): string {
    if (this.publicUrl) {
      return `${this.publicUrl}/${path.replace(/^\//, "")}`;
    }
    // When no explicit public URL is configured, default to the local bucket
    // server so Slack Block Kit button URLs remain valid http:// links. If the
    // bucket server is disabled, fall back to the absolute filesystem path.
    if (cfg.storage.enableBucketServer && cfg.storage.bucketHttpPort > 0) {
      return `http://localhost:${cfg.storage.bucketHttpPort}/${path.replace(/^\//, "")}`;
    }
    return join(this.baseDir, path);
  }
}

type Uploader = typeof uploadFiles;

export class HuggingFaceBucket implements Bucket {
  private repo: `buckets/${string}`;
  private token: string;
  private uploader: Uploader;

  constructor(repo: string, token: string, uploader: Uploader = uploadFiles) {
    if (!repo) throw new Error("HF bucket repo must not be empty");
    this.repo = repo.startsWith("buckets/") ? (repo as `buckets/${string}`) : `buckets/${repo}`;
    this.token = token;
    this.uploader = uploader;
  }

  async write(path: string, content: string | Buffer, _contentType?: string): Promise<void> {
    await this.uploader({
      repo: this.repo,
      files: [{ path: path.replace(/^\//, ""), content: new Blob([content]) }],
      accessToken: this.token,
      commitTitle: "Moon Bot artifact upload",
      commitDescription: `Upload ${path}`,
    });
  }

  async read(path: string): Promise<Buffer> {
    const normalized = path.replace(/^\//, "");
    const blob = await downloadFile({
      repo: this.repo,
      path: normalized,
      accessToken: this.token,
    });
    if (!blob) {
      throw new Error(`Bucket object not found: ${path}`);
    }
    return Buffer.from(await blob.arrayBuffer());
  }

  readUrl(path: string): string {
    const normalized = path.replace(/^\//, "");
    const hubBase = HUB_URL.replace(/\/$/, "");
    return `${hubBase}/${this.repo}/resolve/main/${normalized}`;
  }
}

export function createBucket(): Bucket {
  if (cfg.hf.bucketRepo && cfg.hf.token) {
    return new HuggingFaceBucket(cfg.hf.bucketRepo, cfg.hf.token);
  }
  return new LocalBucket(cfg.storage.bucketDir, cfg.storage.bucketPublicUrl);
}

export const bucket: Bucket = createBucket();
