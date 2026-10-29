// Composes every surface into one Hono app on one port: REST + OpenAPI, MCP, llms.txt, media, web UI.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { apiRoutes, mediaFileRoutes } from "./api.ts";
import { controlRoutes } from "./control-api.ts";
import { pluginRoutes } from "./plugins-api.ts";
import { guardRequest, requireAuth } from "./auth.ts";
import { env, ROOT, VERSION } from "./env.ts";
import { errorResponse } from "./http.ts";
import { llmsRoutes } from "./llms.ts";
import { mcpRoutes } from "./mcp.ts";
import { pushRoutes } from "./push.ts";

export { VERSION };
export const app = new OpenAPIHono();
app.onError(errorResponse);
app.notFound((c) => c.json({ error: "not_found", message: `No route for ${c.req.method} ${c.req.path}` }, 404));

app.use("*", guardRequest);
app.use("/api/*", requireAuth);
app.use("/mcp", requireAuth);
app.use("/mcp/*", requireAuth);
app.use("/media/*", requireAuth);
// The full guide lists this instance's accounts and settings; the short /llms.txt stays public.
app.use("/llms-full.txt", requireAuth);

app.route("/api", apiRoutes);
app.route("/api", controlRoutes);
app.route("/api", pluginRoutes);
app.route("/api/push", pushRoutes);
app.route("/media", mediaFileRoutes);
app.route("/mcp", mcpRoutes);
app.route("/", llmsRoutes);

app.openAPIRegistry.registerComponent("securitySchemes", "bearer", { type: "http", scheme: "bearer" });
app.doc31("/openapi.json", (c) => ({
  openapi: "3.1.0",
  info: {
    title: "Yaypost API",
    version: VERSION,
    description:
      "Social publishing run by AI agents: draft, check, schedule and publish posts and threads on X, Bluesky, Mastodon, Threads, LinkedIn, Telegram " +
      "and Discord, read their engagement, and continue published threads. Agents do the work; the person decides: what an agent queues waits for " +
      "their approval (web UI, Telegram, Discord; see the Approvals tag and each post's `approval`), and they can pause everything. Credentials stay on " +
      "the server; counting, resumable publishing and scheduling are handled here. The same capabilities are on MCP at /mcp and the `yaypost` CLI. " +
      "Threads are arrays of segments, or one string with lines of `---` between posts. Send `Idempotency-Key` on POSTs you might retry.",
  },
  servers: [{ url: env.publicUrl ?? new URL(c.req.url).origin }],
  security: [{ bearer: [] }],
  tags: [
    { name: "Posts", description: "Drafts and threads: create, edit (autosave), schedule, publish, export for copy & paste." },
    { name: "Queue", description: "Posting slots from yaypost.config.json and the day-grouped queue." },
    { name: "Platforms", description: "What each supported platform allows (limits, images, how threads land) and costs." },
    { name: "Accounts", description: "Connected accounts per platform. Credentials are verified on connect, stored encrypted and never returned." },
    { name: "Metrics", description: "Engagement data per destination, for agents to analyse. No built-in dashboards or rules: the agent decides." },
    { name: "Approvals", description: "The person's side: approve or send back what agents queue, pause everything, audit log, digest, approval chats." },
    { name: "Plugins", description: "Platforms and approval chats are plugins: list, browse npm, install, update, switch on/off (owner only)." },
    { name: "Media", description: "Images attached to posts (PNG, JPEG, WebP, GIF; ≤5 MB; ≤4 per post)." },
    { name: "Events", description: "Server-Sent Events stream of every state change." },
    { name: "Webhooks", description: "HMAC-signed outbound webhooks for the same events." },
    { name: "Notifications", description: "Web Push reminders for the browser." },
    { name: "System", description: "Health, config, version." },
  ],
}));
app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Yaypost API" }));

// No OAuth discovery here (auth is a static bearer token); answer JSON 404 instead of the SPA's HTML so MCP clients
// that probe /.well-known/* fall back cleanly.
app.all("/.well-known/*", (c) => c.json({ error: "not_found", message: "No OAuth metadata: use Authorization: Bearer <AUTH_TOKEN>" }, 404));

// Built web UI (vite build → dist/web). In dev, Vite serves the UI on :5173 and proxies here.
const webDir = path.join(ROOT, "dist", "web");
if (existsSync(webDir)) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", (c) => c.html(readFileSync(path.join(webDir, "index.html"), "utf8")));
} else {
  app.get("/", (c) =>
    c.text("Yaypost API is running. Build the UI with `pnpm build`, or run `pnpm dev` and open http://localhost:5173."),
  );
}
