// Outbound webhooks: every bus event is POSTed to each subscribed URL. Failures never reach the bus.
// Format "json" is our HMAC-signed envelope; "slack" and "discord" incoming webhooks only take a chat message, so those
// get one readable line instead (picked from the URL when the webhook is added). Each delivery is logged (last 50 per
// webhook) with its body and the receiver's answer, and can be sent again.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { APP_EVENT_TYPES, EVENT_LABEL, type AppEventType, type Post } from "../shared/types.ts";
import { webhookFormatFor, type WebhookFormat } from "../shared/webhooks.ts";
import { db } from "./db.ts";
import { bus } from "./events.ts";
import { BadInputError, NotFoundError } from "./repo.ts";


export interface Webhook {
  id: string;
  url: string;
  events: AppEventType[];
  enabled: boolean;
  format: WebhookFormat;
  createdAt: string;
  lastStatus: number | null;
  lastError: string | null;
  lastAt: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null; // HTTP status of the last attempt; null when the request never got a response
  error: string | null;
}

export interface Delivery extends DeliveryResult {
  id: string;
  type: string;
  at: string;
  attempts: number;
  /** The body as sent. */
  body: string;
  /** The start of the receiver's answer. */
  response: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  enabled: number;
  format: WebhookFormat;
  created_at: string;
  last_status: number | null;
  last_error: string | null;
  last_at: string | null;
}
interface DeliveryRow {
  id: string;
  webhook_id: string;
  type: string;
  at: string;
  body: string;
  attempts: number;
  ok: number;
  status: number | null;
  error: string | null;
  response: string | null;
}

const TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2_000, 10_000]; // 3 attempts in total
const KEEP_DELIVERIES = 50;

const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events),
  enabled: r.enabled === 1,
  format: r.format,
  createdAt: r.created_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  lastAt: r.last_at,
});
const toDelivery = (r: DeliveryRow): Delivery => ({
  id: r.id,
  type: r.type,
  at: r.at,
  attempts: r.attempts,
  ok: r.ok === 1,
  status: r.status,
  error: r.error,
  body: r.body,
  response: r.response,
});

const rows = () => db.prepare("SELECT * FROM webhooks ORDER BY created_at").all() as unknown as WebhookRow[];

function requireRow(id: string): WebhookRow {
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
  if (!row) throw new NotFoundError(`Webhook ${id} not found`);
  return row;
}

function checkUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BadInputError("That isn't a URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadInputError("Use an http(s) URL.");
}

export function listWebhooks(): Webhook[] {
  return rows().map(toWebhook);
}

/** The secret is returned only here; receivers use it to verify `X-Yaypost-Signature`. */
export function createWebhook(input: { url: string; events?: AppEventType[]; format?: WebhookFormat }): Webhook & { secret: string } {
  checkUrl(input.url);
  const id = randomUUID();
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const events = input.events?.length ? [...new Set(input.events)] : APP_EVENT_TYPES;
  db.prepare("INSERT INTO webhooks (id, url, secret, events, format, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    input.url,
    secret,
    JSON.stringify(events),
    input.format ?? webhookFormatFor(input.url),
    new Date().toISOString(),
  );
  return { ...toWebhook(requireRow(id)), secret };
}

/** Change a webhook in place: same id and secret. A new URL re-picks the format unless one is given. */
export function updateWebhook(id: string, patch: { url?: string; events?: AppEventType[]; enabled?: boolean; format?: WebhookFormat }): Webhook {
  const row = requireRow(id);
  if (patch.url !== undefined) checkUrl(patch.url);
  if (patch.events && !patch.events.length) throw new BadInputError("Pick at least one event, or pause the webhook instead.");
  const url = patch.url ?? row.url;
  const format = patch.format ?? (patch.url !== undefined && patch.url !== row.url ? webhookFormatFor(url) : row.format);
  db.prepare("UPDATE webhooks SET url = ?, events = ?, enabled = ?, format = ? WHERE id = ?").run(
    url,
    patch.events ? JSON.stringify([...new Set(patch.events)]) : row.events,
    patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    format,
    id,
  );
  return toWebhook(requireRow(id));
}

export function deleteWebhook(id: string): void {
  requireRow(id);
  db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
}

export function listDeliveries(id: string, limit = KEEP_DELIVERIES): Delivery[] {
  requireRow(id);
  return (db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY at DESC LIMIT ?").all(id, limit) as unknown as DeliveryRow[]).map(
    toDelivery,
  );
}

/** Sends one `ping` delivery (no retries) and reports how the endpoint answered. */
export function testWebhook(id: string): Promise<DeliveryResult> {
  return deliver(requireRow(id), "ping", { webhookId: id, message: "Yaypost webhook test" }, 1);
}

/** Sends a logged delivery's exact body again (one attempt), as a new delivery. */
export function resendDelivery(id: string, deliveryId: string): Promise<DeliveryResult> {
  const hook = requireRow(id);
  const row = db.prepare("SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ?").get(deliveryId, id) as DeliveryRow | undefined;
  if (!row) throw new NotFoundError(`Delivery ${deliveryId} not found`);
  return deliver(hook, row.type, null, 1, row.body);
}

// ---------- rendering ----------

const ICON: Record<string, string> = {
  "post.published": "✅",
  "post.failed": "❌",
  "post.due": "⏰",
  "post.approval_requested": "🙋",
  "post.approved": "👍",
  "post.changes_requested": "✏️",
  "post.rejected": "🚫",
  "publishing.paused": "⏸️",
  "publishing.resumed": "▶️",
  ping: "🔔",
};

/** One line a person reads in Slack or Discord. */
function chatText(type: string, data: Record<string, unknown>): string {
  const label = EVENT_LABEL[type as AppEventType] ?? type;
  const icon = ICON[type] ?? "•";
  if (type === "ping") return `${icon} Yaypost webhook test: this channel will get your events.`;
  if (data.post) {
    const post = data.post as Post;
    const first = (post.title || post.thread[0]?.text || "").trim().split("\n")[0]!.slice(0, 140) || "Empty post";
    const link = post.url ?? post.targets.find((t) => t.url)?.url;
    const extra =
      type === "post.failed" && post.error ? `\n> ${post.error}` : type === "post.changes_requested" && post.approval?.note ? `\n> ${post.approval.note}` : "";
    return `${icon} ${label}: “${first}”${link ? ` ${link}` : ""}${extra}`;
  }
  if (type.startsWith("publishing.")) return `${icon} ${label} by ${String(data.by)}${data.reason ? `: ${String(data.reason)}` : ""}`;
  return `${icon} ${label}${data.id ? ` (${String(data.id)})` : ""}`;
}

function render(format: WebhookFormat, id: string, type: string, data: Record<string, unknown>): string {
  if (format === "slack") return JSON.stringify({ text: chatText(type, data) });
  if (format === "discord") return JSON.stringify({ content: chatText(type, data), allowed_mentions: { parse: [] } });
  return JSON.stringify({ id, type, createdAt: new Date().toISOString(), data });
}

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

async function attempt(url: string, body: string, headers: Record<string, string>): Promise<DeliveryResult & { response: string | null }> {
  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = (await res.text().catch(() => "")).trim().slice(0, 500);
    return { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, response: text || null };
  } catch (err) {
    const e = err as Error & { cause?: Error };
    const error = e.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000}s` : (e.cause?.message ?? e.message);
    return { ok: false, status: null, error, response: null };
  }
}

async function deliver(hook: WebhookRow, type: string, data: unknown, maxAttempts = 1 + RETRY_DELAYS_MS.length, sameBody?: string): Promise<DeliveryResult> {
  const id = randomUUID();
  const body = sameBody ?? render(hook.format, id, type, (data ?? {}) as Record<string, unknown>);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "Yaypost-Webhooks",
    "X-Yaypost-Event": type,
    "X-Yaypost-Delivery": id,
    "X-Yaypost-Signature": sign(hook.secret, body),
  };
  const now = () => new Date().toISOString();
  db.prepare("INSERT INTO webhook_deliveries (id, webhook_id, type, at, body) VALUES (?, ?, ?, ?, ?)").run(id, hook.id, type, now(), body);
  db.prepare(
    "DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY at DESC LIMIT ?)",
  ).run(hook.id, hook.id, KEEP_DELIVERIES);
  for (let n = 1; ; n++) {
    const result = await attempt(hook.url, body, headers);
    db.prepare("UPDATE webhook_deliveries SET attempts = ?, ok = ?, status = ?, error = ?, response = ? WHERE id = ?").run(
      n,
      result.ok ? 1 : 0,
      result.status,
      result.error,
      result.response,
      id,
    );
    db.prepare("UPDATE webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?").run(result.status, result.error, now(), hook.id);
    // Other 4xx answers (bad URL, auth) won't fix themselves within seconds.
    const retryable = result.status === null || result.status >= 500 || result.status === 408 || result.status === 429;
    if (result.ok || !retryable || n >= maxAttempts) return { ok: result.ok, status: result.status, error: result.error };
    await sleep(RETRY_DELAYS_MS[n - 1]);
  }
}

let started = false;

export function startWebhooks(): void {
  if (started) return;
  started = true;
  bus.on((event) => {
    try {
      const { type, ...data } = event;
      for (const hook of rows()) {
        if (!hook.enabled || !(JSON.parse(hook.events) as string[]).includes(type)) continue;
        deliver(hook, type, data).catch((err) => console.error(`webhook ${hook.url}:`, err));
      }
    } catch (err) {
      console.error("webhooks:", err);
    }
  });
}
