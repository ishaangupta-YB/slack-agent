import { readFileSync } from "node:fs";
import path from "node:path";

export function generateSlackManifestUrl(manifestPath?: string): string {
  const file = manifestPath ?? path.resolve(process.cwd(), "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  const encoded = encodeURIComponent(JSON.stringify(manifest));
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encoded}`;
}

function main(): void {
  console.log(generateSlackManifestUrl());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
