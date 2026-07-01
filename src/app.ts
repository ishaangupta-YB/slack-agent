import { app } from "./slack.js";
import { cfg } from "./config.js";
import { startBucketServer } from "./storage/server.js";
import { initializeTools, shutdownTools } from "./tools/registry.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startEsProxy, stopEsProxy } from "./proxy/es.js";

(async () => {
  if (cfg.storage.enableBucketServer) {
    await startBucketServer();
  }
  await startEsProxy();
  await initializeTools();
  startScheduler(app);
  await app.start();
  console.log("Moon Bot is running in Socket Mode");
})();

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  stopScheduler();
  stopEsProxy();
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
