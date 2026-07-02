#!/usr/bin/env node
/**
 * Moon Bot pre-flight configuration diagnostic.
 *
 * Run this before starting the bot in Slack to catch missing env vars,
 * unwritable directories, and incomplete integration configs. It exits
 * non-zero when the configuration is not ready for production use.
 */
import "dotenv/config";
import { runDiagnostics, formatDiagnosticResultForConsole } from "../src/diagnostics.js";

async function main(): Promise<number> {
  const result = await runDiagnostics();
  console.log(formatDiagnosticResultForConsole(result));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Diagnostic crashed:", err);
    process.exit(2);
  });
