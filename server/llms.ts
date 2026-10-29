// /llms.txt (llmstxt.org index) and /llms-full.txt (the whole agent guide, with a route list generated
// from the live OpenAPI document) so any agent can learn to drive Yaypost from one URL.
import { Hono } from "hono";
import { listAccounts } from "./accounts.ts";
import { threadGuide } from "./guide.ts";
import { getConfig } from "./config.ts";
import { env } from "./env.ts";
import { mcpCatalog } from "./mcp.ts";
import { platformName } from "./plugins.ts";

export const llmsRoutes = new Hono();

const origin = (url: string) => env.publicUrl?.replace(/\/+$/, "") ?? new URL(url).origin;
const authLine = () =>
  env.authToken
    ? `Every /api, /mcp and /media request needs \`Authorization: Bearer <token>\`${env.agentToken ? " (agents get AGENT_TOKEN: everything except deciding on approvals, resuming publishing and managing accounts)" : ""}.`
    : "This instance needs no token (it should only be reachable from this machine or a private network).";

const approvalLine = () => {
  const { approval } = getConfig();
  return approval.require === "agents"
    ? `Approval: everything an agent schedules or publishes waits for the person's decision (web UI, Telegram, Discord)${approval.except.length ? `, except posts only to ${approval.except.join(", ")}` : ""}. Queuing is the ask. A post's \`approval.state\` is pending, then approved (it goes out), changes_requested (\`approval.note\` says what to change: revise with PATCH, which asks again) or rejected (back to drafts). Agents can't approve.`
    : "Approval: off on this instance (approval.require = never): what agents schedule or publish goes out as is.";
};

llmsRoutes.get("/llms.txt", (c) => {
  const base = origin(c.req.url);
  return c.text(`# Yaypost

> The publishing layer for AI agents: draft, check, schedule and publish posts and threads on X, Bluesky, Mastodon, Threads, LinkedIn, Telegram and Discord, read their engagement and continue threads. Agents do the work; the person keeps the credentials and only decides: they approve, send back or reject what agents queue, from the web UI or their Telegram/Discord chat, and can pause everything. Draft once, give each platform its own version if needed, count characters the way each platform does, queue posts into time slots, and publish to every connected account. Everything the UI does is available to agents over REST, MCP, a CLI, webhooks and server-sent events.

Base URL: ${base}. ${authLine()}
${approvalLine()}
Threads are one text with a line containing only \`---\` between posts (or an array of segments). Times are ISO-8601 date-times (without an offset they are read in ${getConfig().timezone}); \`"next"\` means the next free posting slot. Per-platform limits: \`GET /api/platforms\` (an account's own \`maxChars\` overrides it).
Destinations: a post's \`targets\` are connected accounts (\`GET /api/accounts\`), each optionally with its own version; a post without targets can only be a draft. \`GET /api/posts/{id}/preview\` shows what each destination gets and whether it fits. Posting through X's API is paid per post; the other platforms are free.

## Docs
- [Full agent guide](${base}/llms-full.txt): conventions, workflows, every route and MCP tool, CLI usage and writing guidance in one file
- [API reference](${base}/docs): interactive reference for the REST API
- [OpenAPI 3.1 spec](${base}/openapi.json): machine-readable; each route says what it does and when to use it

## Agent interfaces
- [MCP endpoint](${base}/mcp): Streamable HTTP, stateless. Claude Code: \`claude mcp add --transport http yaypost ${base}/mcp${env.authToken ? ' --header "Authorization: Bearer <AUTH_TOKEN>"' : ""}\`${env.authToken ? `. Clients that can't send headers (claude.ai / ChatGPT connectors) use ${base}/mcp?token=<AUTH_TOKEN> over HTTPS` : ""}
- [CLI](${base}/llms-full.txt): zero-dependency Node script \`cli/yaypost.mjs\` (\`yaypost new "text" --at next\`, \`yaypost queue\`, \`--json\` everywhere); set YAYPOST_URL and YAYPOST_TOKEN
- [Health](${base}/api/health): version, whether publishing is paused, timezone
- [Approvals](${base}/api/approvals): what waits for the person or was sent back with changes; [control](${base}/api/control): approval policy, pause, chats
- [Accounts](${base}/api/accounts) and [platforms](${base}/api/platforms): where posts can go, each platform's limits, counting rule (as data) and cost
- [Plugins](${base}/api/plugins): every platform and approval chat is a plugin; this lists what is loaded (and why a plugin failed)

## Events
- [Webhooks](${base}/openapi.json): \`POST /api/webhooks {url, events?}\`; deliveries are signed with \`X-Yaypost-Signature: sha256=<HMAC-SHA256 of the raw body>\`
- [Event stream](${base}/api/events): server-sent events for every post change, approvals (post.approval_requested, post.approved, post.changes_requested, post.rejected) and publishing.paused/resumed

## Optional
- [Writing guide](${base}/llms-full.txt): what makes a thread work, each platform's counting rules and limits, and X's per-post API costs
`);
});

llmsRoutes.get("/llms-full.txt", async (c) => {
  const { app, VERSION } = await import("./app.ts"); // lazy: app.ts imports this module
  const base = origin(c.req.url);
  const config = getConfig();
  const accounts = listAccounts();
  const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "Yaypost API", version: VERSION } });

  const routes: string[] = [];
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = item?.[method];
      if (op) routes.push(`- \`${method.toUpperCase()} ${p}\` — ${op.summary ?? op.description?.split(". ")[0] ?? ""}`);
    }
  }

  return c.text(`# Yaypost — full guide for agents

> The publishing layer for AI agents: posts and threads on X, Bluesky, Mastodon, Threads, LinkedIn, Telegram and Discord, with engagement data.
> Single process, SQLite, no user accounts; connected social accounts' credentials are stored encrypted and never returned.
> Every UI capability is reachable over REST (+ OpenAPI), MCP, the CLI, webhooks and server-sent events.

## This instance
- URL: ${base} (version ${VERSION})
- Connected accounts: ${
    accounts.length
      ? accounts.map((a) => `${a.label} (${platformName(a.platform)}${a.handle ? ` ${a.handle}` : ""}, id ${a.id}${a.lastError ? `, ERROR: ${a.lastError}` : ""})`).join("; ")
      : "none yet (nothing can be scheduled or published until the person connects accounts in the UI)"
  }
- ${approvalLine()}
- Timezone: ${config.timezone}
- Auth: ${authLine()}

## Conventions
- Thread format: one string with a line containing only \`---\` between posts, or \`thread: [{text, mediaIds?}]\`. A single post is a thread of one.
- Destinations: \`targets: [{accountId, thread?}]\` on POST/PATCH /api/posts. \`thread\` is that account's own version (null = the post's thread;
  omitted on PATCH = keep the current one). Scheduling or publishing a post without targets answers 409. Each target has its own \`status\`, \`externalIds\`
  (items live there), \`url\` and \`error\`; the post is \`published\` when all are, \`failed\` when any failed (retry resumes only those).
  LinkedIn joins a thread into one post; Telegram and Discord send consecutive messages; the others post a reply chain.
- Accounts: \`GET /api/accounts\`; connecting (\`POST /api/accounts {platform, credentials, label?, maxChars?}\`, verified first, 400 with the
  platform's reason) needs the person's secrets, so leave it to them. \`POST /api/accounts/{id}/check\` re-verifies; \`DELETE\` is refused (409)
  while unfinished posts still target the account.
- Counting: each platform its own way (table in the guide below). X weighs characters: most Latin text counts 1 per character; CJK and emoji count 2; Vietnamese letters from Unicode's
  Latin Extended Additional block (ạ, ả, ấ, ệ, ố, ở, ữ…) count 2, while á, à, ã, é, ó, ơ, ư, đ and the like count 1; every URL counts 23.
  The same Vietnamese post can fit Bluesky and be over on X.
- Statuses: draft → scheduled → publishing → published, or failed (see \`error\`; retry resumes a thread without duplicates).
${
    config.lateGraceMinutes > 0
      ? `  \`due\` means the post waits for the person: it missed its time by more than ${config.lateGraceMinutes} minutes (the server was down) and did not go out late; \`error\` says why.
  \`POST /api/posts/{id}/publish\` or \`/retry\` on a due post publishes it.\n`
      : ""
  }- Partly published threads: if publishing fails mid-thread, the first \`externalIds.length\` items of that destination are live and locked;
  a PATCH that changes, removes or reorders them answers 409. Edit only the posts after them, then retry.
- Times: ISO-8601 date-times. With \`Z\` or an offset (\`2026-11-03T09:00:00+07:00\`) they are exact; without one (\`2026-11-03T09:00\`) they are read in ${config.timezone}.
  Date-only and free-form values and times in the past answer 400. \`"next"\` = next free slot from yaypost.config.json.
- Retries: every POST under /api accepts \`Idempotency-Key: <uuid>\`. Repeating a request with the same key on the same path
  replays the first response (status and JSON body) with the header \`Idempotent-Replayed: true\` instead of acting twice.
- Attribution: send \`X-Yaypost-Source: cli\` from scripts; anything that isn't the web UI counts as an agent for approvals.
- Errors: JSON \`{error, message}\` with 400 (invalid input), 401 (token), 403 (only the person may do that), 404, 409 (wrong state, e.g. editing a published post, or the post waits for approval), 500.
- Kill switch: \`POST /api/control/pause {reason}\` stops every publish until the person resumes; use it when something goes wrong.

## Recommended workflow
1. \`GET /api/health\` (timezone, paused), \`GET /api/config\` (slots, voice examples count) and \`GET /api/approvals\` (anything sent back to you).
2. Pick destinations: \`GET /api/accounts\`.
3. Draft in the person's voice and language; check counts per platform (MCP \`count_characters {platform}\`, CLI \`yaypost count --platform p\`).
   Where one thread can't suit every destination, write per-destination versions.
4. Queue it: \`POST /api/posts {text, targets, title, scheduledAt: "next" | ISO}\`, then \`GET /api/posts/{id}/preview\` and fix every \`problem\`.
   With approval on, this is the request: the person gets the exact preview and decides; follow up on \`post.changes_requested\` (webhook/SSE or \`GET /api/approvals\`).
5. Report what you queued and when it would go out, in their timezone. \`GET /api/queue?days=7\` shows the timeline with free slots.
6. Posting by hand (e.g. a due post): \`GET /api/posts/{id}/export\` gives the text; after posting, \`POST /api/posts/{id}/mark-published {url?}\`.
7. Images: \`POST /api/media\` (multipart \`file\`, \`alt\`) or \`POST /api/media/from-url {url, alt}\`, then put the media id in a segment's \`mediaIds\`
   (per-platform maximum and accepted types in the table below).
Publishing is irreversible: with approval off, ask the person before publishing; never delete what they didn't ask you to.
8. Data, not dashboards: \`GET /api/metrics\` (recent published posts with per-destination totals) and \`GET /api/posts/{id}/metrics?refresh=true\`
   (Bluesky, Mastodon, Threads free; X billed, only with \`paid=true\`). Yaypost has no analytics views, best-time engine, auto-plug rules or
   evergreen recycler on purpose: analyse the numbers yourself, and act with \`POST /api/posts/{id}/append\` (continue a published thread: a follow-up
   or plug, replying to the last live post on each destination; it asks for approval again) or a new post.

## REST routes (from ${base}/openapi.json)
${routes.join("\n") || "- (no routes registered)"}

## MCP
Endpoint: ${base}/mcp (Streamable HTTP, stateless, JSON responses). Claude Code: \`claude mcp add --transport http yaypost ${base}/mcp${env.authToken ? ' --header "Authorization: Bearer <AUTH_TOKEN>"' : ""}\`.
Resource \`yaypost://guide\` holds the writing guide; prompt \`draft_thread {topic, notes?}\` walks through drafting and queueing.
You write the text yourself. Tool errors come back as \`isError\` results with the same messages REST gives.
There is deliberately no tool to connect accounts (it needs the person's secrets); \`list_accounts\` shows what is connected.
${mcpCatalog()
  .map((t) => `- \`${t.name}\` — ${t.description}`)
  .join("\n")}

## CLI
\`node cli/yaypost.mjs <command>\` (or \`yaypost\` when linked). Env: YAYPOST_URL (default http://127.0.0.1:3000), YAYPOST_TOKEN.
Every command accepts \`--json\` for machine-readable output. Exit codes: 0 ok, 1 API error, 2 usage error.
- \`new [text] [--file f|-] [--at next|ISO] [--to ref,ref] [--version ref=file]... [--image [N:]path]... [--title t]\` — create a draft or scheduled post (stdin works too)
- \`queue [--days n]\`, \`list [--status s,s]\`, \`show <id>\` (with per-destination status), \`preview <id>\`, \`slots [n]\`
- \`edit <id> [text|--file f] [--to ref,ref|none] [--version ref=file|ref=none]...\`, \`schedule <id> <next|ISO>\`, \`unschedule <id>\`, \`rm <id>\`
- \`publish <id>\`, \`retry <id>\`, \`copy <id> [--clipboard]\`, \`posted <id> [--url u]\`
- \`accounts\` (\`accounts check <ref>\`), \`platforms\`
- \`count [text|--file f] [--platform p] [--max n]\` — local count per post the way that platform counts (default X)
- \`reviews\` (waiting on the person / sent back), \`pause [reason]\`, \`resume\`, \`approve|reject <id> [--note n]\`, \`changes <id> <note>\` (deciding needs the owner token), \`audit\`, \`feedback\` (what the person said about past posts), \`digest\`
- \`health\`, \`help\`
Account refs (\`--to\`, \`--version\`): id or id prefix, label, handle, or platform name when only one account of it is connected.
Ids can be shortened to any unique prefix.

## Webhooks and events
- \`POST /api/webhooks {url, events?}\` returns a \`secret\` once. Each delivery is \`POST {id, type, createdAt, data}\` with headers
  \`X-Yaypost-Event\` and \`X-Yaypost-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>\`; 3 attempts with backoff.
  Verify in Node: \`crypto.createHmac("sha256", secret).update(rawBody).digest("hex")\` and compare with timingSafeEqual.
- \`GET /api/events\` streams the same events as server-sent events (event name = type, data = JSON).
- Event types: post.created, post.updated, post.scheduled, post.due, post.published, post.failed, post.deleted, post.approval_requested,
  post.approved, post.changes_requested, post.rejected (each with \`post\`), publishing.paused, publishing.resumed (with \`by\`, \`reason\`).

${threadGuide().replace(/^(#+) /gm, "#$1 ")}`);
});
