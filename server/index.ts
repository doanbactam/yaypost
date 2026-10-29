// Single process: HTTP server + scheduler loop + event fan-out (webhooks, approval chats).
import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { getConfig } from "./config.ts";
import { env, publicUrl, VERSION } from "./env.ts";
import { startAccountChecks } from "./accounts.ts";
import { startAudit } from "./audit.ts";
import { alert, channelStatuses, startNotify } from "./notify/hub.ts";
import { listPlatforms, listPlugins, loadPlugins } from "./plugins.ts";
import { recoverInterrupted } from "./repo.ts";
import { startScheduler } from "./scheduler.ts";
import { startWebhooks } from "./webhooks.ts";

const config = getConfig();
// Platforms and approval chats are plugins: load them before anything publishes or takes requests.
await loadPlugins();
const recovered = recoverInterrupted();
if (recovered) console.warn(`⚠ ${recovered} post(s) were mid-publish when the process stopped; marked failed for review.`);

startAudit();
startWebhooks();
const stopNotify = startNotify();
startAccountChecks((a) => {
  console.warn(`⚠ ${a.label}: ${a.lastError}`);
  alert(`⚠ ${a.label} needs attention: ${a.lastError ?? ""}\nPosts to it will fail until you reconnect it in Yaypost.`);
});
const stopScheduler = startScheduler();

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, () => {
  console.log(`Yaypost ${VERSION} → ${publicUrl()}`);
  console.log(`  timezone ${config.timezone}`);
  const chats = channelStatuses().filter((c) => c.configured).map((c) => c.id);
  const broken = listPlugins().filter((p) => p.error).length;
  console.log(`  plugins: ${listPlugins().filter((p) => !p.error && !p.disabled).length} loaded${broken ? `, ${broken} failed (GET /api/plugins)` : ""} · platforms: ${listPlatforms().map((p) => p.id).join(", ") || "none"}`);
  console.log(`  approvals: ${getConfig().approval.require === "never" ? "off (agents publish directly)" : "agents need your OK"} · chats: ${chats.join(", ") || "none (approve in the web UI)"}`);
  console.log(`  API docs ${publicUrl()}/docs · MCP ${publicUrl()}/mcp · agents ${publicUrl()}/llms.txt`);
  if (process.env.X_API_KEY?.trim()) {
    console.warn("⚠ X_API_KEY and the other X_* keys in .env are no longer read. Connect X as an account (Settings › Accounts) with the same keys.");
  }
  if (!env.authToken && env.host !== "127.0.0.1" && env.host !== "localhost") {
    console.warn("⚠ Listening beyond localhost without AUTH_TOKEN — anyone who can reach this port can post as you.");
  }
});

/** Stop taking work, let a publish in progress finish (up to 30 s), then exit (75 when a restart was asked for). */
async function shutdown() {
  stopNotify();
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  setTimeout(() => process.exit(code), 30_000).unref();
  await stopScheduler();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
