import { app } from "./slack.js";
import { cfg } from "./config.js";
import { startBucketServer } from "./storage/server.js";
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
    console.log("Moon Bot startup check passed — ready to start in Socket Mode");
    await shutdownTools();
    process.exit(0);
  }

  await startScheduler(app);
  await app.start();
  console.log("Moon Bot is running in Socket Mode");
})();

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  stopScheduler();
  stopEsProxy();
  stopPlausibleProxy();
  stopHfProxy();
  try {
    await app.stop();
  } catch {
    // ignore
  }
  await shutdownTools();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
