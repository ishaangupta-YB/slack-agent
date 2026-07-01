import { app } from "./slack.js";

(async () => {
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
