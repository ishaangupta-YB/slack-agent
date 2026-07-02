import { z } from "zod";
import { modelInfo, datasetInfo, spaceInfo } from "@huggingface/hub";
import type { Tool } from "./types.js";
import { cfg } from "../config.js";

const params = z.object({
  repo_id: z
    .string()
    .describe(
      "HuggingFace Hub repo id, e.g. 'meta-llama/Llama-2-7b-hf', 'glue', or 'philschmid/document-ai'.",
    ),
  repo_type: z
    .enum(["model", "dataset", "space"])
    .optional()
    .default("model")
    .describe("Type of HuggingFace Hub repo: model, dataset, or space."),
});

export interface HfHubInfoResult {
  id: string;
  likes: number;
  private: boolean;
  updatedAt: Date;
  downloads?: number;
  gated?: false | "auto" | "manual";
  tags?: string[];
  task?: string;
  sdk?: string;
  library_name?: string;
}

type HfHubInfoExecutor = (repoId: string, repoType: "model" | "dataset" | "space") => Promise<HfHubInfoResult>;

let executor: HfHubInfoExecutor | undefined;

export function setHfHubInfoExecutor(fn: HfHubInfoExecutor): void {
  executor = fn;
}

export function clearHfHubInfoExecutor(): void {
  executor = undefined;
}

function formatDate(date?: Date): string {
  if (!date) return "unknown";
  try {
    return date.toISOString();
  } catch {
    return String(date);
  }
}

async function fetchHubInfo(
  repoId: string,
  repoType: "model" | "dataset" | "space",
): Promise<HfHubInfoResult> {
  if (executor) {
    return executor(repoId, repoType);
  }

  const credentials = cfg.hf.token ? { accessToken: cfg.hf.token } : undefined;

  if (repoType === "model") {
    const info = await modelInfo({ name: repoId, additionalFields: ["tags", "library_name"], ...credentials });
    return {
      id: info.id,
      likes: info.likes,
      private: info.private,
      updatedAt: info.updatedAt,
      downloads: info.downloads,
      gated: info.gated,
      tags: info.tags,
      task: info.task,
      library_name: info.library_name,
    };
  }

  if (repoType === "dataset") {
    const info = await datasetInfo({ name: repoId, additionalFields: ["tags"], ...credentials });
    return {
      id: info.id,
      likes: info.likes,
      private: info.private,
      updatedAt: info.updatedAt,
      downloads: info.downloads,
      gated: info.gated,
      tags: info.tags,
    };
  }

  const info = await spaceInfo({ name: repoId, additionalFields: ["tags"], ...credentials });
  return {
    id: info.id,
    likes: info.likes,
    private: info.private,
    updatedAt: info.updatedAt,
    sdk: info.sdk,
    tags: info.tags,
  };
}

function renderInfo(info: HfHubInfoResult): string {
  const lines: string[] = [
    `**${info.id}**`,
    `• likes: ${info.likes.toLocaleString()}`,
    `• private: ${info.private ? "yes" : "no"}`,
    `• last modified: ${formatDate(info.updatedAt)}`,
  ];

  if (info.downloads !== undefined) {
    lines.push(`• downloads: ${info.downloads.toLocaleString()}`);
  }
  if (info.gated !== undefined) {
    lines.push(`• gated: ${info.gated === false ? "no" : info.gated}`);
  }
  if (info.task) {
    lines.push(`• task: ${info.task}`);
  }
  if (info.sdk) {
    lines.push(`• sdk: ${info.sdk}`);
  }
  if (info.library_name) {
    lines.push(`• library: ${info.library_name}`);
  }
  if (info.tags && info.tags.length > 0) {
    lines.push(`• tags: ${info.tags.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Look up metadata for a HuggingFace Hub model, dataset, or space.
 * Useful for answering codebase questions that reference HF artifacts or for
 * choosing the right model/dataset for a task without leaving Slack.
 */
export const hfHubInfoTool: Tool = {
  name: "hf_hub_info",
  description:
    "Look up metadata for a HuggingFace Hub model, dataset, or space by repo id. Returns author, tags, task, downloads, likes, gated status, and last modified date.",
  params,
  tier: "basic",
  githubBot: true,
  async run(input) {
    try {
      const info = await fetchHubInfo(input.repo_id, input.repo_type);
      return renderInfo(info);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes("not found") || message.includes("404")) {
        return `Repo '${input.repo_id}' (${input.repo_type}) was not found on the HuggingFace Hub.`;
      }
      if (message.toLowerCase().includes("unauthorized") || message.includes("401")) {
        return `Could not access '${input.repo_id}': ${message}. A HuggingFace token with the required permissions may be needed.`;
      }
      return `HuggingFace Hub lookup failed for '${input.repo_id}': ${message}`;
    }
  },
};
