import { app } from "./slack.js";
import { cfg } from "./config.js";
import { startBucketServer } from "./storage/server.js";

(async () => {
  if (cfg.storage.enableBucketServer) {
    await startBucketServer();
  }
  await app.start();
  console.log("Moon Bot is running in Socket Mode");
})();

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await app.stop();
  process.exit(0);
});
