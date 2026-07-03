import { cfg } from "./config.js";
import { startBucketServer, stopBucketServer } from "./storage/server.js";
import { initializeTools, shutdownTools } from "./tools/registry.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startEsProxy, stopEsProxy } from "./proxy/es.js";
import { startPlausibleProxy, stopPlausibleProxy } from "./proxy/plausible.js";
import { startHfProxy, stopHfProxy } from "./proxy/hf.js";

const isCheckMode = process.argv.includes("--check");

(async () => {
  if (cfg.storage.enableBucketServer) {
    await startBucketServer();
  }
  await startEsProxy();
  await startPlausibleProxy();
  await startHfProxy();
  await initializeTools();

  if (isCheckMode) {
    console.log(
      cfg.githubBot.enabled
        ? "Ishu startup check passed — ready to start in GitHub-only mode"
        : "Ishu startup check passed — ready to start in Socket Mode",
    );
    await shutdownTools();
    stopEsProxy();
    stopPlausibleProxy();
    stopHfProxy();
    stopBucketServer();
    process.exit(0);
  }

  if (cfg.githubBot.enabled) {
    const { startGitHubBotServer } = await import("./github-bot.js");
    await startGitHubBotServer();
    return;
  }

  const { app } = await import("./slack.js");
  await startScheduler(app);
  await app.start();
  console.log("Ishu is running in Socket Mode");
})();

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  await stopScheduler();
  stopEsProxy();
  stopPlausibleProxy();
  stopHfProxy();
  stopBucketServer();
  if (!cfg.githubBot.enabled) {
    try {
      const { app } = await import("./slack.js");
      await app.stop();
    } catch {
      // ignore
    }
  } else {
    const { stopGitHubBotServer } = await import("./github-bot.js");
    stopGitHubBotServer();
  }
  await shutdownTools();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
