import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cfg } from "../config.js";

export interface Bucket {
  write(path: string, content: string | Buffer, contentType?: string): Promise<void>;
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

  readUrl(path: string): string {
    if (this.publicUrl) {
      return `${this.publicUrl}/${path.replace(/^\//, "")}`;
    }
    return join(this.baseDir, path);
  }
}

export const bucket: Bucket = new LocalBucket(
  cfg.storage.bucketDir,
  cfg.storage.bucketPublicUrl,
);
