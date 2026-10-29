// Web Push (VAPID) to subscribed browsers: "Time to post" when a post is due (manual mode, or too late to post
// unattended), plus published/failed notices. Keys are generated once and kept in kv; dead subscriptions (404/410)
// are pruned on send.
import { createRoute, z } from "@hono/zod-openapi";
import webpush, { type VapidKeys } from "web-push";
import type { AppEvent } from "../shared/types.ts";
import { db, kv } from "./db.ts";
import { env } from "./env.ts";
import { bus } from "./events.ts";
import { createRouter } from "./http.ts";

/** What the service worker (web/public/sw.js) receives. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  postId: string | null;
  tag: string;
  /** Keep the notification on screen until the user acts (used for "Time to post"). */
  requireInteraction?: boolean;
}

let keys: VapidKeys | undefined;
function vapidKeys(): VapidKeys {
  keys ??= kv.get<VapidKeys>("vapid");
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    kv.set("vapid", keys);
  }
  return keys;
}

const preview = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

function payloadFor(event: AppEvent): PushPayload | null {
  if (event.type === "publishing.paused") {
    return { title: "Publishing paused", body: preview(`By ${event.by}${event.reason ? `: ${event.reason}` : ""}`, 240), url: "/", postId: null, tag: "paused" };
  }
  if (!("post" in event)) return null;
  const { post } = event;
  const first = preview(post.thread[0]?.text ?? "", 120);
  switch (event.type) {
    case "post.due":
      // `error` on a due post says why it needs a human (missed its time while offline, part already live).
      return {
        title: "Time to post",
        body: preview([first || "Your scheduled post is ready to copy.", post.error].filter(Boolean).join(" — "), 240),
        url: `/?post=${post.id}&copy=1`,
        postId: post.id,
        tag: `due-${post.id}`,
        requireInteraction: true,
      };
    case "post.approval_requested":
      return { title: "Approval needed", body: first, url: `/?post=${post.id}`, postId: post.id, tag: `approval-${post.id}` };
    case "post.failed":
      return { title: "Post failed", body: preview(post.error ?? "Publishing failed.", 240), url: `/?post=${post.id}`, postId: post.id, tag: `failed-${post.id}` };
    case "post.published":
      // Only threads Yaypost posted itself; "mark published" after posting by hand needs no notification.
      if (!post.xPostIds.length) return null;
      return { title: "Posted to X", body: first, url: post.url ?? `/?post=${post.id}`, postId: post.id, tag: `published-${post.id}` };
    default:
      return null;
  }
}

export async function sendToAll(payload: PushPayload) {
  const subs = db.prepare("SELECT endpoint, keys FROM push_subscriptions").all() as unknown as { endpoint: string; keys: string }[];
  const { publicKey, privateKey } = vapidKeys();
  const result = { subscriptions: subs.length, sent: 0, failed: 0, removed: 0 };
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(payload), {
          vapidDetails: { subject: env.vapidSubject, publicKey, privateKey },
          TTL: 24 * 3600,
          urgency: "high",
          timeout: 10_000,
        });
        result.sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
          result.removed++;
        } else {
          result.failed++;
          console.warn(`[push] ${new URL(s.endpoint).host}: ${status ?? ""} ${(err as Error).message}`.trim());
        }
      }
    }),
  );
  return result;
}

export function startPush(): void {
  vapidKeys();
  bus.on((event) => {
    void (async () => {
      const payload = payloadFor(event);
      if (payload) await sendToAll(payload);
    })().catch((err) => console.warn(`[push] ${event.type}: ${(err as Error).message}`));
  });
}

// ---------- routes (/api/push) ----------

const tags = ["Notifications"];
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const Ok = z.object({ ok: z.literal(true) });

const Subscription = z
  .object({
    endpoint: z.url({ protocol: /^https$/ }).openapi({ description: "Push service URL from the browser's PushSubscription" }),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  })
  .openapi("PushSubscription");

const TestResult = z.object({
  ok: z.literal(true),
  subscriptions: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  removed: z.number().int().openapi({ description: "Expired subscriptions deleted during this send" }),
  message: z.string(),
});

export const pushRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/public-key",
      tags,
      summary: "Get the VAPID public key",
      description: "Pass it as `applicationServerKey` to `pushManager.subscribe()` in the browser, then POST the subscription to /api/push/subscribe.",
      responses: { 200: json(z.object({ publicKey: z.string() }), "URL-safe base64 VAPID public key") },
    }),
    (c) => c.json({ publicKey: vapidKeys().publicKey }, 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/subscribe",
      tags,
      summary: "Register a browser for notifications",
      description:
        "Body is the browser's `PushSubscription.toJSON()`. The browser then gets a notification when a post is due (manual mode: time to copy & post), published, or failed. Re-subscribing the same endpoint updates its keys.",
      request: { body: { required: true, content: { "application/json": { schema: Subscription } } } },
      responses: { 200: json(Ok, "Subscribed") },
    }),
    (c) => {
      const sub = c.req.valid("json");
      db.prepare(
        "INSERT INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys",
      ).run(sub.endpoint, JSON.stringify(sub.keys), new Date().toISOString());
      return c.json({ ok: true as const }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/unsubscribe",
      tags,
      summary: "Stop notifications for a browser",
      description: "Removes the subscription with this endpoint. Succeeds even if it was already gone.",
      request: { body: { required: true, content: { "application/json": { schema: z.object({ endpoint: z.string().min(1) }) } } } },
      responses: { 200: json(Ok, "Unsubscribed") },
    }),
    (c) => {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(c.req.valid("json").endpoint);
      return c.json({ ok: true as const }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/test",
      tags,
      summary: "Send a test notification",
      description: "Sends a test notification to every subscribed browser and reports how many were delivered to the push services.",
      responses: { 200: json(TestResult, "Delivery summary") },
    }),
    async (c) => {
      const r = await sendToAll({
        title: "Yaypost notifications work",
        body: "You'll get a notification like this when a post is due, published or fails.",
        url: "/",
        postId: null,
        tag: "test",
      });
      const message = r.subscriptions
        ? `Sent to ${r.sent} of ${r.subscriptions} browser(s)${r.removed ? `; removed ${r.removed} expired` : ""}${r.failed ? `; ${r.failed} failed (see server log)` : ""}.`
        : "No browser is subscribed yet. Open Yaypost in a browser and turn on notifications.";
      return c.json({ ok: true as const, ...r, message }, 200);
    },
  );
