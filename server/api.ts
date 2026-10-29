// REST API mounted at /api (documented at /openapi.json), plus /media/:id file serving.
import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { countWith } from "../shared/counting.ts";
import { threadToText } from "../shared/thread.ts";
import { APP_EVENT_TYPES, APPROVAL_STATES, POST_STATUSES, type Health, type PlatformId, type Post, type PostSource, type PostStatus } from "../shared/types.ts";
import { connectAccount, deleteAccount, getAccount, listAccounts, recheckAccount, updateAccount } from "./accounts.ts";
import { buildQueue, configError, getConfig, nextFreeSlots, parseInstant, parseWhen, writeConfig } from "./config.ts";
import { requireOwner } from "./actor.ts";
import type { ThreadMode } from "./plugin-api.ts";
import { hasPlatform, itemsFor, listPlatforms, platform, platformInfo, threadModeOf } from "./plugins.ts";
import { pauseState } from "./control.ts";
import { db } from "./db.ts";
import { env, VERSION } from "./env.ts";
import { createRouter } from "./http.ts";
import { publishedWithMetrics, refreshMetrics } from "./metrics.ts";
import { saveImage, saveImageFromUrl } from "./media.ts";
import { limitFor, preflight } from "./publisher.ts";
import {
  appendToPost,
  attemptsFor,
  BadInputError,
  createPost,
  deleteMedia,
  deletePost,
  getMedia,
  IMAGE_MIMES,
  listPosts,
  markPublishedManually,
  MAX_IMAGE_BYTES,
  NotFoundError,
  requirePost,
  schedulePost,
  unschedulePost,
  updateMediaAlt,
  updatePost,
  type SegmentInput,
  type TargetInput,
} from "./repo.ts";
import { publishNow, retryPost } from "./scheduler.ts";
import { eventStream } from "./sse.ts";
import { WEBHOOK_FORMATS } from "../shared/webhooks.ts";
import { createWebhook, deleteWebhook, listDeliveries, listWebhooks, resendDelivery, testWebhook, updateWebhook } from "./webhooks.ts";

// ---------- schemas (named ones become components in /openapi.json) ----------

const When = z
  .union([
    z.literal("next"),
    // Parsed by config.parseWhen, the same parser MCP uses, so both surfaces accept and reject the same values.
    z.string().min(1),
  ])
  .openapi({
    description:
      '"next" takes the next free posting slot from yaypost.config.json; otherwise an ISO-8601 date-time, with Z or an offset, or without one ' +
      "for a wall-clock time in the configured timezone (GET /config). A date alone (ambiguous) and a time already past are refused with 400.",
    example: "next",
  });
const DateFilter = z.string().optional();

const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "not_found", description: "Machine-readable code: invalid_request, bad_request, unauthorized, not_found, conflict, internal." }),
    message: z.string().openapi({ description: "Human-readable explanation; safe to show to the user." }),
  })
  .openapi("Error");

const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

const SegmentSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    mediaIds: z.array(z.string()).openapi({ description: "Media ids attached to this post (X, Bluesky, Mastodon: max 4; see GET /platforms)." }),
  })
  .openapi("Segment", { description: "One post of a thread." });

const PlatformIdSchema = z
  .string()
  .refine((id) => hasPlatform(id), { message: "unknown platform; GET /api/platforms lists the loaded ones" })
  .openapi("PlatformId", { description: "A platform provided by a loaded plugin; GET /platforms lists them with their limits." });

const MetricFields = {
  likes: z.number().int().optional(),
  reposts: z.number().int().optional(),
  replies: z.number().int().optional(),
  quotes: z.number().int().optional(),
  views: z.number().int().optional(),
  bookmarks: z.number().int().optional(),
};
const TargetMetricsSchema = z
  .object({
    fetchedAt: z.iso.datetime(),
    items: z.array(z.object({ id: z.string(), ...MetricFields })),
    totals: z.object(MetricFields),
  })
  .openapi("TargetMetrics", { description: "Public engagement as the platform reports it; a metric is absent when the platform doesn't expose it." });

const PostTargetSchema = z
  .object({
    accountId: z.string().openapi({ description: "Connected account (GET /accounts)." }),
    platform: PlatformIdSchema,
    thread: z.array(SegmentSchema).nullable().openapi({
      description: "This destination's own version of the thread; null = it publishes the post's `thread`. LinkedIn joins the posts of whichever thread it gets into one post.",
    }),
    status: z.enum(["pending", "published", "failed"]).openapi({ description: "pending: not published yet · published: live there · failed: see `error`; Retry resumes after `externalIds`." }),
    externalIds: z.array(z.string()).openapi({ description: "Ids of the items already posted on that platform, in order (a retry resumes after them)." }),
    url: z.string().nullable().openapi({ description: "Public link to the first item once published there." }),
    error: z.string().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    snapshot: z.boolean().openapi({ description: "true: `thread` is a record of what this destination published from the shared thread, not a separate version." }),
    metrics: TargetMetricsSchema.nullable().openapi({ description: "Last stored engagement (refresh with GET /posts/{id}/metrics?refresh=true); null until fetched." }),
  })
  .openapi("PostTarget", { description: "One destination of a post: a connected account, with its own publish status and progress." });

export const PostSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable().openapi({ description: "Private label; never posted." }),
    status: z.enum(POST_STATUSES).openapi({
      description:
        "draft: not queued · scheduled: waits for scheduledAt · publishing: platform API calls in flight · " +
        "due: its time came but it needs a human — it was more than lateGraceMinutes " +
        "late because the server was off (`error` says why; publish, retry or reschedule it) · published: live everywhere it was sent · " +
        "failed: a platform refused it (see `error`, and each target's `status`/`error`; retry resumes after what already went out: each target's `externalIds`).",
    }),
    thread: z.array(SegmentSchema).openapi({ description: "Posts in thread order; a single post is a one-item thread." }),
    scheduledAt: z.iso.datetime().nullable(),
    publishedAt: z.iso.datetime().nullable(),
    error: z.string().nullable(),
    url: z.string().nullable().openapi({ description: "Link to the first destination's post once published." }),
    targets: z.array(PostTargetSchema).openapi({
      description:
        "Destinations (connected accounts); at least one is needed to schedule or publish. " +
        "Each target publishes and resumes independently; `status` summarises them. Credentials are never returned.",
    }),
    approval: z
      .object({
        state: z.enum(APPROVAL_STATES),
        note: z.string().nullable().openapi({ description: "The person's feedback (changes requested, or why they rejected it)." }),
        by: z.string().nullable().openapi({ description: "Who asked (while pending) or decided, e.g. agent:mcp, owner:telegram:@alice." }),
        at: z.iso.datetime().nullable(),
      })
      .nullable()
      .openapi({
        description:
          "The person's approval of agent-made content. null: none needed. pending: waits for the person; changes_requested: revise it (note says how), " +
          "which asks again; approved: may go out; rejected: back to drafts. Pending and changes_requested posts are never published.",
      }),
    source: z.enum(["ui", "api", "mcp", "cli", "ai", "operator"]),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Post", { description: "A single post or a thread, with its destinations and scheduling state." });

const PostDetailSchema = PostSchema.extend({
  attempts: z
    .array(z.object({ at: z.iso.datetime(), ok: z.boolean(), detail: z.string().nullable() }))
    .openapi({ description: "Publish attempts, newest first (max 50)." }),
}).openapi("PostDetail");

const SegmentInputSchema = z
  .object({
    id: z.string().optional().openapi({ description: "Existing segment id to keep when editing; omit for new posts." }),
    text: z.string(),
    mediaIds: z.array(z.string()).max(20).optional().openapi({
      description:
        "Image ids from POST /media. Per post: X, Bluesky and Mastodon allow 4, Telegram and Discord 10, Threads and LinkedIn 20; Threads takes only JPEG/PNG and LinkedIn JPEG/PNG/GIF " +
        "(GET /platforms → maxImages, imageTypes). Checked per destination (GET /posts/{id}/preview) before anything is published.",
    }),
  })
  .openapi("SegmentInput");

const threadFields = {
  text: z.string().optional().openapi({
    description: "The whole thread as one string; a line containing only `---` separates posts. Send this OR `thread`.",
    example: "Posts are separated by a line of three dashes.\n---\nThis is the second post.",
  }),
  thread: z.array(SegmentInputSchema).optional().openapi({ description: "Structured posts in order. Send this OR `text`." }),
  title: z.string().max(200).nullable().optional().openapi({ description: "Private label shown in the UI; never posted." }),
  targets: z
    .array(
      z
        .object({
          accountId: z.string().min(1).openapi({ description: "A connected account id from GET /accounts." }),
          thread: z.array(SegmentInputSchema).min(1).nullable().optional().openapi({
            description:
              "A version of the thread just for this account (e.g. shorter for X, one long post for LinkedIn). null = publish the post's own thread. " +
              "On PATCH, omitting it keeps the account's current version.",
          }),
        })
        .openapi("TargetInput"),
    )
    .optional()
    .openapi({
      description:
        "Where the post goes: connected accounts (GET /accounts), each optionally with its own version. A post without any can only be a draft. " +
        "On PATCH it replaces the whole list; omitted = unchanged. A destination with part of the thread already live can't be removed (409).",
    }),
};
const notBoth = (b: { text?: unknown; thread?: unknown }) => b.text === undefined || b.thread === undefined;
const NOT_BOTH = "send either `text` or `thread`, not both";

const CreatePostSchema = z
  .object({ ...threadFields, scheduledAt: When.nullable().optional() })
  .refine(notBoth, NOT_BOTH)
  .openapi("CreatePost");
const UpdatePostSchema = z.object(threadFields).refine(notBoth, NOT_BOTH).openapi("UpdatePost");

const MediaSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    mime: z.enum(Object.keys(IMAGE_MIMES) as [string, ...string[]]),
    size: z.number().int(),
    alt: z.string().nullable(),
    url: z.string().openapi({ description: "Path of the image file (served outside /api, e.g. /media/<id>); prefix the server origin." }),
    createdAt: z.iso.datetime(),
  })
  .openapi("Media");

const QueueSlotSchema = z
  .object({ type: z.literal("slot"), at: z.iso.datetime() })
  .openapi("QueueSlot", { description: "A free posting slot from the config." });
const QueuePostSchema = z.object({ type: z.literal("post"), at: z.iso.datetime(), post: PostSchema }).openapi("QueuePost");
const QueueSchema = z
  .object({
    timezone: z.string(),
    days: z.array(
      z.object({
        date: z.string().openapi({ description: "YYYY-MM-DD in the configured timezone." }),
        items: z.array(z.discriminatedUnion("type", [QueueSlotSchema, QueuePostSchema])),
      }),
    ),
  })
  .openapi("Queue");

const ConfigSchema = z
  .object({
    timezone: z.string(),
    slots: z.array(
      z.union([
        z.object({ days: z.string(), times: z.array(z.string()) }),
        z.object({ days: z.string(), from: z.string(), to: z.string(), everyMinutes: z.number().int() }),
      ]),
    ),
    schedulerIntervalSeconds: z.number().int(),
    lateGraceMinutes: z.number().int().openapi({
      description: "A scheduled post found more than this many minutes late (the server was off) becomes due instead of posting unattended; 0 = always post.",
    }),
    voiceCount: z.number().int().openapi({ description: "How many voice samples agents get (get_settings voiceExamples)." }),
    configError: z.string().nullable().openapi({
      description: "Why the latest edit of yaypost.config.json was rejected (the previous valid config stays in use until it is fixed); null when the file is fine.",
    }),
  })
  .openapi("Config");

const HealthSchema = z
  .object({
    ok: z.literal(true),
    version: z.string(),
    timezone: z.string(),
    paused: z.boolean().openapi({ description: "true while publishing is paused (kill switch); nothing goes out." }),
    auth: z.object({ required: z.boolean() }),
  })
  .openapi("Health");

const EventType = z.enum(APP_EVENT_TYPES);
const AppEventSchema = z
  .union([
    z.object({ type: EventType.exclude(["post.deleted", "publishing.paused", "publishing.resumed"]), post: PostSchema }),
    z.object({ type: z.literal("post.deleted"), id: z.string() }),
    z.object({ type: z.enum(["publishing.paused", "publishing.resumed"]), by: z.string(), reason: z.string().nullable() }),
  ])
  .openapi("AppEvent", { description: "Emitted on every state change, from any surface (UI, API, MCP, scheduler)." });

const WebhookSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    events: z.array(EventType),
    enabled: z.boolean().openapi({ description: "false = paused: no deliveries until it is turned back on." }),
    format: z.enum(WEBHOOK_FORMATS).openapi({
      description: "json = the signed WebhookDelivery envelope; slack / discord = a one-line chat message ({text} / {content}) those incoming webhooks accept.",
    }),
    createdAt: z.iso.datetime(),
    lastStatus: z.number().int().nullable().openapi({ description: "HTTP status of the latest delivery attempt; null if it got no response." }),
    lastError: z.string().nullable(),
    lastAt: z.iso.datetime().nullable(),
  })
  .openapi("Webhook");
const WebhookCreatedSchema = WebhookSchema.extend({
  secret: z.string().openapi({ description: "HMAC key for X-Yaypost-Signature. Shown only once — store it now." }),
}).openapi("WebhookCreated");
const WebhookDeliverySchema = z
  .object({
    id: z.string().openapi({ description: "Delivery id (also in X-Yaypost-Delivery); dedupe on it." }),
    type: z.union([EventType, z.literal("ping")]),
    createdAt: z.iso.datetime(),
    data: z.record(z.string(), z.unknown()).openapi({ description: "The event minus `type`: { post } for post.* events, { id } for post.deleted." }),
  })
  .openapi("WebhookDelivery", {
    description:
      "Body POSTed to webhook URLs. Headers: X-Yaypost-Event (= type), X-Yaypost-Delivery (= id), " +
      "X-Yaypost-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the webhook secret>.",
  });

const DeliveryLogSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    at: z.iso.datetime(),
    attempts: z.number().int(),
    ok: z.boolean(),
    status: z.number().int().nullable(),
    error: z.string().nullable(),
    body: z.string().openapi({ description: "The request body as sent." }),
    response: z.string().nullable().openapi({ description: "The first 500 characters of the answer." }),
  })
  .openapi("WebhookDeliveryLog");
const WebhookResultSchema = z.object({ ok: z.boolean(), status: z.number().int().nullable(), error: z.string().nullable() }).openapi("WebhookTestResult");

const AccountSchema = z
  .object({
    id: z.string(),
    platform: PlatformIdSchema,
    label: z.string().openapi({ description: "Your name for it; MCP and the CLI accept it as a destination reference." }),
    handle: z.string().nullable().openapi({ description: "Who the credentials belong to, as the platform names it (e.g. @you, you.bsky.social)." }),
    profileUrl: z.string().nullable(),
    maxChars: z.number().int().nullable().openapi({ description: "Per-account character limit override (X Premium, a Mastodon instance's own limit); null = the platform's." }),
    lastError: z.string().nullable().openapi({ description: "Why the latest check or publish was refused (e.g. an expired token); null when fine. Fix with PATCH credentials." }),
    verifiedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("Account", { description: "A connected social account. Credentials are stored encrypted and never returned." });

const PlatformInfoSchema = z
  .object({
    id: PlatformIdSchema,
    name: z.string(),
    maxChars: z.number().int().openapi({ description: "Default per-post limit (an account's maxChars overrides it)." }),
    maxCharsWithMedia: z.number().int().optional().openapi({ description: "Lower limit for an item with images (Telegram photo captions)." }),
    maxImages: z.number().int(),
    imageTypes: z.array(z.string()).optional().openapi({ description: "Accepted image MIME types when the platform is pickier than PNG/JPEG/WebP/GIF." }),
    maxImageBytes: z.number().int().optional(),
    counting: z
      .union([
        z.object({ method: z.literal("x-weighted") }),
        z.object({ method: z.literal("graphemes") }),
        z.object({ method: z.literal("codepoints"), urlLength: z.number().int().optional(), emoji: z.literal("utf8-bytes").optional() }),
      ])
      .openapi("CountingRule", {
        description:
          "How the platform counts characters, as data. x-weighted: X's twitter-text rules (CJK, emoji and Vietnamese ạ ệ ố… count 2, URLs 23); " +
          "graphemes: user-perceived characters; codepoints: Unicode code points, with every URL counted as urlLength and/or each emoji as its UTF-8 bytes.",
      }),
    threadMode: z.enum(["replies", "single", "messages"]).openapi({
      description: "How a thread lands: replies = each post replies to the previous one; single = joined into one post with blank lines (LinkedIn); messages = consecutive messages (Telegram, Discord).",
    }),
    costNote: z.string(),
    credentials: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        secret: z.boolean(),
        optional: z.boolean().optional(),
        placeholder: z.string().optional(),
        help: z.string().optional(),
      }),
    ),
    setup: z.string().openapi({ description: "Where to get the credentials." }),
    metricsNote: z.string().optional(),
    metricsPaid: z.boolean().optional().openapi({ description: "Metric reads are billed; fetched only with paid=true." }),
    hasMetrics: z.boolean().openapi({ description: "Whether engagement numbers can be read (GET /posts/{id}/metrics)." }),
    brand: z.object({ color: z.string(), iconPath: z.string().optional() }).optional(),
  })
  .openapi("PlatformInfo", { description: "A platform, as its plugin declares it." });


const PreviewSchema = z
  .object({
    targets: z.array(
      z.object({
        accountId: z.string(),
        platform: PlatformIdSchema,
        label: z.string(),
        limit: z.number().int(),
        threadMode: z.enum(["replies", "single", "messages"]),
        status: z.enum(["pending", "published", "failed"]),
        live: z.number().int().openapi({ description: "Items already posted there; publishing resumes after them." }),
        items: z.array(
          z.object({
            text: z.string(),
            count: z.number().int().openapi({ description: "Characters as this platform counts them." }),
            fits: z.boolean(),
            images: z.number().int(),
          }),
        ),
        problem: z.string().nullable().openapi({ description: "What would make publishing to this destination fail before anything is posted; null = ready." }),
      }),
    ),
  })
  .openapi("PostPreview");

// ---------- helpers ----------

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, required = true) => ({ required, content: { "application/json": { schema } } });
const E400 = json(ErrorSchema, "Invalid input; `message` names the field and the problem.");
const E404 = json(ErrorSchema, "Not found.");
const E409 = json(ErrorSchema, "Not allowed in the current state (e.g. the post is already published or publishing).");
const AccountIdParam = z.object({ id: z.string().openapi({ description: "Account id (GET /accounts)." }) });
const IdParam = z.object({ id: z.string().openapi({ description: "Resource id (UUID)." }) });
const IdemHeader = z.object({
  "Idempotency-Key": z.string().max(200).optional().openapi({
    description:
      "Retry-safe POST: a repeat request to the same path with the same key (within 24 h) gets the first successful answer again, " +
      "same status and body, with header Idempotent-Replayed: true, instead of acting twice. Error answers (4xx/5xx) are not stored. " +
      "Note that publish and retry answer 200 even when X rejected the post (status \"failed\"); that answer is replayed too, so use a new key to try again.",
  }),
});
const IdemHeaders = IdemHeader.extend({
  "X-Yaypost-Source": z.string().optional().openapi({ description: "Who created the post: ui, cli or ai. Anything else is recorded as api." }),
});

const badRequest = (message: string) => new HTTPException(400, { message });

function sourceOf(c: Context): PostSource {
  const s = c.req.header("x-yaypost-source");
  return s === "ui" || s === "cli" || s === "ai" ? s : "api";
}

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const idempotencyInFlight = new Map<string, Promise<unknown>>();

/**
 * Idempotency-Key on every POST under /api, scoped per path so one key can't replay another endpoint's answer.
 * The first 2xx JSON answer is stored and replayed; a concurrent repeat waits for the first request to finish.
 */
const idempotency: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (c.req.method !== "POST" || !key) return next();
  if (key.length > 200) throw new BadInputError("Idempotency-Key must be at most 200 characters");
  const scope = `POST ${c.req.path} ${key}`;
  for (let p; (p = idempotencyInFlight.get(scope)); ) await p;
  const hit = db
    .prepare("SELECT response FROM idempotency WHERE key = ? AND created_at >= ?")
    .get(scope, new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()) as { response: string } | undefined;
  if (hit) {
    const { status, body } = JSON.parse(hit.response) as { status: 200; body: unknown };
    return c.json(body, status, { "Idempotent-Replayed": "true" });
  }
  // No await between the in-flight check above and this set, so two concurrent requests can't both get here.
  let release!: () => void;
  idempotencyInFlight.set(scope, new Promise<void>((r) => (release = r)));
  try {
    await next();
    if (c.res.ok && c.res.headers.get("content-type")?.startsWith("application/json")) {
      const ts = Date.now();
      db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(new Date(ts - IDEMPOTENCY_TTL_MS).toISOString());
      db.prepare("INSERT OR IGNORE INTO idempotency (key, response, created_at) VALUES (?, ?, ?)").run(
        scope,
        JSON.stringify({ status: c.res.status, body: await c.res.clone().json() }),
        new Date(ts).toISOString(),
      );
    }
  } finally {
    // Released only after the answer is stored, so a waiting repeat finds it.
    idempotencyInFlight.delete(scope);
    release();
  }
};

const when = parseWhen;

/** List filter bound: a date-time (see parseInstant), or a date alone meaning that day's start in the configured timezone. */
const bound = (s: string | undefined) => (s ? parseInstant(/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? `${s.trim()}T00:00` : s) : undefined);

function checkMedia(thread?: { mediaIds?: string[] }[], targets?: { thread?: { mediaIds?: string[] }[] | null }[]) {
  const all = [...(thread ?? []), ...(targets ?? []).flatMap((t) => t.thread ?? [])];
  const missing = all.flatMap((s) => s.mediaIds ?? []).filter((id) => !getMedia(id));
  if (missing.length) throw badRequest(`Unknown media id(s): ${missing.join(", ")}. Upload images with POST /api/media first.`);
}

/** PATCH semantics for targets: a target that omits `thread` keeps the version it already has. */
export function mergeTargets(post: Post, targets: { accountId: string; thread?: SegmentInput[] | null }[]): TargetInput[] {
  return targets.map((t) => ({
    accountId: t.accountId,
    thread: t.thread !== undefined ? t.thread : (post.targets.find((o) => o.accountId === t.accountId)?.thread ?? null),
  }));
}

export interface PreviewTarget {
  accountId: string;
  platform: PlatformId;
  label: string;
  limit: number;
  threadMode: ThreadMode;
  status: "pending" | "published" | "failed";
  live: number;
  items: { text: string; count: number; fits: boolean; images: number }[];
  problem: string | null;
}

/** What each destination would receive, counted its way, and what would stop it (the same checks publishing runs). */
export function previewPost(post: Post): { targets: PreviewTarget[] } {
  return {
    targets: post.targets.map((t) => {
      const account = getAccount(t.accountId);
      const limit = limitFor(account);
      const items = itemsFor({ threadMode: threadModeOf(t.platform) }, t.thread ?? post.thread).map((s) => {
        const count = countWith(platform(t.platform).counting, s.text);
        const { maxImages, imageTypes, maxCharsWithMedia } = platform(t.platform);
        const max = s.mediaIds.length && maxCharsWithMedia ? Math.min(limit, maxCharsWithMedia) : limit;
        const typesOk = !imageTypes || s.mediaIds.every((id) => imageTypes.includes(getMedia(id)?.mime ?? imageTypes[0]!));
        const fits = count <= max && s.mediaIds.length <= maxImages && typesOk && Boolean(s.text.trim() || s.mediaIds.length);
        return { text: s.text, count, fits, images: s.mediaIds.length };
      });
      const pending = itemsFor({ threadMode: threadModeOf(t.platform) }, t.thread ?? post.thread).slice(t.externalIds.length);
      return {
        accountId: account.id,
        platform: t.platform,
        label: account.label,
        limit,
        threadMode: threadModeOf(t.platform),
        status: t.status,
        live: t.externalIds.length,
        items,
        problem: t.status === "published" ? null : preflight(account, pending),
      };
    }),
  };
}

// ---------- routes ----------

export const apiRoutes = createRouter();
// Registered first so it wraps every route; mounted at /api, it also covers the other routers under /api.
apiRoutes.use("*", idempotency);

// Not used by any route body, but agents need these shapes.
apiRoutes.openAPIRegistry.register("AppEvent", AppEventSchema);
apiRoutes.openAPIRegistry.register("WebhookDelivery", WebhookDeliverySchema);

// Posts

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/posts",
    tags: ["Posts"],
    operationId: "listPosts",
    summary: "List posts",
    description:
      "Lists drafts, queued and past posts. Without from/to: newest first by scheduledAt (or updatedAt for drafts). " +
      "With from/to: only posts whose scheduledAt falls in [from, to), oldest first — drafts have no scheduledAt, so they are excluded. " +
      "For a calendar view with free slots use GET /queue instead.",
    request: {
      query: z.object({
        status: z
          .string()
          .optional()
          .refine((s) => !s || s.split(",").every((x) => POST_STATUSES.includes(x.trim() as PostStatus)), `comma-separated list of: ${POST_STATUSES.join(", ")}`)
          .openapi({ description: `Comma-separated filter: ${POST_STATUSES.join(", ")}.`, example: "draft,scheduled" }),
        from: DateFilter.openapi({
          description: "scheduledAt ≥ from: an ISO-8601 date-time (no offset = configured timezone), or a date alone for that day's local midnight.",
          example: "2026-11-02",
        }),
        to: DateFilter.openapi({ description: "scheduledAt < to, same format as `from`.", example: "2026-11-03" }),
        limit: z.coerce.number().int().min(1).max(1000).optional().openapi({ description: "Default 500." }),
      }),
    },
    responses: { 200: json(z.object({ posts: z.array(PostSchema) }), "Matching posts."), 400: E400 },
  }),
  (c) => {
    const q = c.req.valid("query");
    const status = q.status?.split(",").map((s) => s.trim() as PostStatus);
    return c.json({ posts: listPosts({ status, from: bound(q.from), to: bound(q.to), limit: q.limit }) }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts",
    tags: ["Posts"],
    operationId: "createPost",
    summary: "Create a post or thread (draft or scheduled)",
    description:
      "Creates a draft, or queues it when `scheduledAt` is set. Give the content either as `text` (posts separated by a line containing only `---`) " +
      'or as structured `thread` segments. `scheduledAt: "next"` takes the next free slot from the posting schedule in yaypost.config.json; ' +
      "an ISO date-time must be in the future (no offset = configured timezone; a date alone is refused). " +
      "`targets` lists the connected accounts it goes to (GET /accounts), each optionally with its own version of the thread; without targets it can only be a draft " +
      "(scheduling answers 409). Posts over a destination's limit (GET /platforms, or the account's own maxChars) " +
      "are accepted, but publishing refuses that destination before anything is posted there, so check GET /posts/{id}/preview. " +
      "Send an `Idempotency-Key` header when you might retry.",
    request: { headers: IdemHeaders, body: body(CreatePostSchema) },
    responses: { 201: json(PostSchema, "The created post."), 400: E400, 409: json(ErrorSchema, 'No free slot for "next".') },
  }),
  (c) => {
    const input = c.req.valid("json");
    checkMedia(input.thread, input.targets);
    const targets = input.targets?.map((t) => ({ accountId: t.accountId, thread: t.thread ?? null }));
    const post = createPost({ ...input, targets, scheduledAt: input.scheduledAt ? when(input.scheduledAt) : null, source: sourceOf(c) });
    return c.json(post, 201);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/posts/{id}",
    tags: ["Posts"],
    operationId: "getPost",
    summary: "Get one post with its publish attempts",
    description: "Returns the post plus its publish attempt log (newest first). Check `status` and `error` after publishing.",
    request: { params: IdParam },
    responses: { 200: json(PostDetailSchema, "The post."), 404: E404 },
  }),
  (c) => {
    const { id } = c.req.valid("param");
    return c.json({ ...requirePost(id), attempts: attemptsFor(id) }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/posts/{id}",
    tags: ["Posts"],
    operationId: "updatePost",
    summary: "Edit a post's content, title or destinations",
    description:
      "Replaces the content, the title and/or the destinations; omitted fields stay unchanged. `text` replaces the thread but keeps each post's id and images by position; " +
      "`thread` is taken as given. `targets` replaces the destination list (a target without `thread` keeps its current version; `thread: null` drops it). " +
      "Scheduling is unaffected — use /schedule or /unschedule. Refused with 409 once the post is publishing or published, " +
      "and when it would change, remove or reorder posts that are already live somewhere (a target's first externalIds.length), " +
      "or remove a destination that is partly published.",
    request: { params: IdParam, body: body(UpdatePostSchema) },
    responses: { 200: json(PostSchema, "The updated post."), 400: E400, 404: E404, 409: E409 },
  }),
  (c) => {
    const { targets, ...patch } = c.req.valid("json");
    checkMedia(patch.thread, targets);
    const id = c.req.valid("param").id;
    return c.json(updatePost(id, { ...patch, targets: targets && mergeTargets(requirePost(id), targets) }), 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/posts/{id}",
    tags: ["Posts"],
    operationId: "deletePost",
    summary: "Delete a post",
    description: "Permanently deletes the post from Yaypost (never deletes anything already published anywhere). 409 while it is publishing.",
    request: { params: IdParam },
    responses: { 200: json(OkSchema, "Deleted."), 404: E404, 409: E409 },
  }),
  (c) => {
    deletePost(c.req.valid("param").id);
    return c.json({ ok: true as const }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/schedule",
    tags: ["Posts"],
    operationId: "schedulePost",
    summary: "Queue a post for a time or the next free slot",
    description:
      'Sets status to scheduled. `at: "next"` picks the next free slot from the config (GET /slots/next previews them); ' +
      "an ISO date-time must be in the future (no offset = configured timezone; a date alone is refused). Also reschedules scheduled/due/failed posts.",
    request: { params: IdParam, headers: IdemHeader, body: body(z.object({ at: When })) },
    responses: { 200: json(PostSchema, "The scheduled post."), 400: E400, 404: E404, 409: E409 },
  }),
  (c) => c.json(schedulePost(c.req.valid("param").id, when(c.req.valid("json").at)), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/unschedule",
    tags: ["Posts"],
    operationId: "unschedulePost",
    summary: "Move a post back to drafts",
    description: "Removes it from the queue (status draft, scheduledAt null). Content is kept.",
    request: { params: IdParam, headers: IdemHeader },
    responses: { 200: json(PostSchema, "The post, now a draft."), 404: E404, 409: E409 },
  }),
  (c) => c.json(unschedulePost(c.req.valid("param").id), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/publish",
    tags: ["Posts"],
    operationId: "publishPost",
    summary: "Publish right now",
    description:
      "Publishes immediately to every destination not yet published and waits: returns the post as published, or as failed with `error` " +
      "(platform errors are not HTTP errors here — check `status` and each target's `status`/`error`). Works for draft, scheduled, due and failed posts; " +
      "items already live (a target's externalIds) are not re-sent. A destination whose thread is empty, over its limit or has too many images " +
      "fails before anything is posted there (GET /posts/{id}/preview shows this in advance); the other destinations still go out. " +
      "A post without targets answers 409.",
    request: { params: IdParam, headers: IdemHeader },
    responses: { 200: json(PostSchema, "The post after publishing (check status/error)."), 404: E404, 409: E409 },
  }),
  async (c) => c.json(await publishNow(c.req.valid("param").id), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/retry",
    tags: ["Posts"],
    operationId: "retryPost",
    summary: "Retry a failed post, or publish a due one",
    description:
      "For failed or due posts only (409 otherwise). It publishes now to the destinations that aren't published yet: items already posted " +
      "(a target's externalIds) are not re-sent, each thread resumes after them; this also posts a due post that missed its time while the server was off.",
    request: { params: IdParam, headers: IdemHeader },
    responses: { 200: json(PostSchema, "The post after the retry."), 404: E404, 409: E409 },
  }),
  async (c) => c.json(await retryPost(c.req.valid("param").id), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/mark-published",
    tags: ["Posts"],
    operationId: "markPostPublished",
    summary: "Record that the user posted it by hand",
    description:
      "After the user copied the thread (GET /posts/{id}/export, e.g. for a due post) and posted it themselves, mark it published, optionally with the URL. " +
      "Calling it again on a published post is a no-op (returned unchanged, no event). Refused with 409 while a publish of it is in flight.",
    request: {
      params: IdParam,
      headers: IdemHeader,
      body: body(z.object({ url: z.url({ protocol: /^https?$/ }).optional().openapi({ description: "Link to the first published post." }) }), false),
    },
    responses: { 200: json(PostSchema, "The published post."), 400: E400, 404: E404, 409: E409 },
  }),
  (c) => {
    return c.json(markPublishedManually(c.req.valid("param").id, c.req.valid("json").url), 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/posts/{id}/export",
    tags: ["Posts"],
    operationId: "exportPost",
    summary: "Get the thread as plain text",
    description:
      "For copy & paste posting (the post's own thread, not per-destination versions): `text` is the whole thread with `---` separators, `posts` the individual posts.",
    request: { params: IdParam },
    responses: {
      200: json(
        z
          .object({
            text: z.string(),
            posts: z.array(z.string()),
          })
          .openapi("ThreadExport"),
        "Exported text.",
      ),
      404: E404,
    },
  }),
  (c) => {
    const post = requirePost(c.req.valid("param").id);
    return c.json({ text: threadToText(post.thread), posts: post.thread.map((s) => s.text) }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/duplicate",
    tags: ["Posts"],
    operationId: "duplicatePost",
    summary: "Copy a post into a new draft",
    description:
      "Creates a new unscheduled draft with the same content, images and destinations (each with its own version, none published yet); works for published posts too, e.g. to re-run a thread.",
    request: { params: IdParam, headers: IdemHeaders },
    responses: { 201: json(PostSchema, "The new draft."), 404: E404 },
  }),
  (c) => {
    const src = requirePost(c.req.valid("param").id);
    const post = createPost({
      title: src.title && `${src.title} (copy)`,
      thread: src.thread.map(({ text, mediaIds }) => ({ text, mediaIds })),
      targets: src.targets.map((t) => ({ accountId: t.accountId, thread: t.thread?.map(({ text, mediaIds }) => ({ text, mediaIds })) ?? null })),
      source: sourceOf(c),
    });
    return c.json(post, 201);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/posts/{id}/append",
    tags: ["Posts"],
    operationId: "appendToPost",
    summary: "Continue a published thread",
    description:
      "Adds posts to the end of a published thread and queues them (at `at`, default now): each destination that threads replies to its last live post; " +
      "LinkedIn-style single posts are left as they are. The building block for follow-ups and plugs: an agent decides when (e.g. from GET /metrics) and what to add.",
    request: {
      params: IdParam,
      headers: IdemHeader,
      body: body(
        z.object({
          text: z.string().optional().openapi({ description: "Posts separated by lines of ---." }),
          thread: z.array(SegmentInputSchema).optional(),
          at: When.optional(),
        }),
      ),
    },
    responses: { 200: json(PostSchema, "The post, queued again with the new posts."), 400: E400, 404: E404, 409: E409 },
  }),
  (c) => {
    const { text, thread, at } = c.req.valid("json");
    checkMedia(thread);
    return c.json(appendToPost(c.req.valid("param").id, { text, thread }, at ? when(at) : null), 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/posts/{id}/metrics",
    tags: ["Metrics"],
    operationId: "getPostMetrics",
    summary: "Engagement of a published post, per destination",
    description:
      "Returns the post with each destination's stored `metrics`. With refresh=true, fetches current numbers first (Bluesky, Mastodon, Threads; X only with paid=true " +
      "because X bills reads). `skipped` says why a destination has no fresh numbers. Yaypost doesn't interpret them: compare, rank and decide as you see fit.",
    request: {
      params: IdParam,
      query: z.object({
        refresh: z.enum(["true", "false"]).optional(),
        paid: z.enum(["true", "false"]).optional().openapi({ description: "Allow billed reads (X, about $0.005 per post read)." }),
      }),
    },
    responses: {
      200: json(
        z.object({ post: PostSchema, skipped: z.array(z.object({ accountId: z.string(), platform: z.string(), reason: z.string() })) }),
        "The post with metrics.",
      ),
      404: E404,
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const q = c.req.valid("query");
    if (q.refresh !== "true") return c.json({ post: requirePost(id), skipped: [] }, 200);
    return c.json(await refreshMetrics(id, { paid: q.paid === "true" }), 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/metrics",
    tags: ["Metrics"],
    operationId: "listMetrics",
    summary: "Recent published posts with their engagement",
    description:
      "Compact dataset for analysis: newest published posts, their text, time and per-destination stored totals. Refresh individual posts with GET /posts/{id}/metrics?refresh=true.",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }) },
    responses: {
      200: json(
        z.object({
          posts: z.array(
            z.object({
              id: z.string(),
              publishedAt: z.string().nullable(),
              posts: z.array(z.string()),
              destinations: z.array(
                z.object({ platform: z.string(), accountId: z.string(), url: z.string().nullable(), fetchedAt: z.string().nullable(), totals: z.object(MetricFields).nullable() }),
              ),
            }),
          ),
        }),
        "Published posts with stored engagement.",
      ),
    },
  }),
  (c) =>
    c.json(
      {
        posts: publishedWithMetrics(c.req.valid("query").limit ?? 50).map((p) => ({
          id: p.id,
          publishedAt: p.publishedAt,
          posts: p.thread.map((s) => s.text),
          destinations: p.targets.map((t) => ({
            platform: t.platform,
            accountId: t.accountId,
            url: t.url,
            fetchedAt: t.metrics?.fetchedAt ?? null,
            totals: t.metrics?.totals ?? null,
          })),
        })),
      },
      200,
    ),
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/posts/{id}/preview",
    tags: ["Posts"],
    operationId: "previewPost",
    summary: "Preview what each destination will receive",
    description:
      "Per destination: the items it will publish (its own version or the post's thread; LinkedIn joins the posts into one), each counted the way that platform counts " +
      "(X weighted: Vietnamese letters like ệ and emoji 2, URLs 23; Bluesky graphemes; Mastodon URLs 23; Threads emoji = their UTF-8 bytes; others code points) against the account's limit, and `problem`: " +
      "what would make publishing there fail before anything is posted (null = ready); no entries for a post without targets. " +
      "Check it before scheduling or publishing.",
    request: { params: IdParam },
    responses: { 200: json(PreviewSchema, "One entry per destination."), 404: E404 },
  }),
  (c) => c.json(previewPost(requirePost(c.req.valid("param").id)), 200),
);

// Platforms & accounts

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/platforms",
    tags: ["Platforms"],
    operationId: "listPlatforms",
    summary: "Supported platforms, their limits and the credentials they need",
    description:
      "Per platform: default character limit, images per post, how a thread lands (threadMode), cost note (X's API is paid per post; the others are free), " +
      "the credential fields POST /accounts expects, and where to get them.",
    responses: { 200: json(z.object({ platforms: z.array(PlatformInfoSchema) }), "Every platform the loaded plugins provide.") },
  }),
  (c) => c.json({ platforms: listPlatforms().map(platformInfo) }, 200),
);


apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/accounts",
    tags: ["Accounts"],
    operationId: "listAccounts",
    summary: "List connected accounts",
    description:
      "The accounts posts can go to (use their ids in a post's `targets`). `lastError` set means the latest check or publish was refused, e.g. an expired token. " +
      "Credentials are never returned.",
    responses: { 200: json(z.object({ accounts: z.array(AccountSchema) }), "Connected accounts, oldest first.") },
  }),
  (c) => c.json({ accounts: listAccounts() }, 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/accounts",
    tags: ["Accounts"],
    operationId: "connectAccount",
    summary: "Connect an account",
    description:
      "Verifies the credentials with the platform (a cheap authenticated call; for X about $0.001), then stores them encrypted. `credentials` holds the fields " +
      "GET /platforms lists for that platform. Answers 400 with the platform's reason when they are refused. Connecting needs the person's secrets: " +
      "agents should let the person do this (web UI or this route), never ask them to paste tokens into a chat.",
    request: {
      headers: IdemHeader,
      body: body(
        z
          .object({
            platform: PlatformIdSchema,
            credentials: z.record(z.string(), z.string()).openapi({ description: "Field key → value, per GET /platforms → credentials.", example: { identifier: "you.bsky.social", appPassword: "xxxx-xxxx-xxxx-xxxx" } }),
            label: z.string().max(100).optional().openapi({ description: "Default: platform name + handle." }),
            maxChars: z.number().int().min(1).max(100_000).nullable().optional().openapi({ description: "Override the platform's limit (X Premium 25000, your Mastodon instance's limit)." }),
          })
          .openapi("ConnectAccount"),
      ),
    },
    responses: { 201: json(AccountSchema, "The connected account."), 400: E400 },
  }),
  async (c) => c.json(await connectAccount(c.req.valid("json")), 201),
);

apiRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/accounts/{id}",
    tags: ["Accounts"],
    operationId: "updateAccount",
    summary: "Rename an account, change its limit or replace its credentials",
    description: "New `credentials` are verified first (400 with the platform's reason if refused) and clear `lastError`. `maxChars: null` restores the platform's limit.",
    request: {
      params: AccountIdParam,
      body: body(
        z
          .object({
            label: z.string().max(100).optional(),
            maxChars: z.number().int().min(1).max(100_000).nullable().optional(),
            credentials: z.record(z.string(), z.string()).optional(),
          })
          .openapi("UpdateAccount"),
      ),
    },
    responses: { 200: json(AccountSchema, "The updated account."), 400: E400, 404: E404 },
  }),
  async (c) => c.json(await updateAccount(c.req.valid("param").id, c.req.valid("json")), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/accounts/{id}/check",
    tags: ["Accounts"],
    operationId: "checkAccount",
    summary: "Re-verify an account's stored credentials",
    description: "Asks the platform again (e.g. whether a 60-day token expired). Always 200: `lastError` is null when fine, otherwise the platform's reason.",
    request: { params: AccountIdParam, headers: IdemHeader },
    responses: { 200: json(AccountSchema, "The account with the check's outcome."), 404: E404 },
  }),
  async (c) => c.json(await recheckAccount(c.req.valid("param").id), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/accounts/{id}",
    tags: ["Accounts"],
    operationId: "deleteAccount",
    summary: "Disconnect an account",
    description:
      "Deletes the account and its stored credentials (nothing is deleted on the platform). Refused with 409 while queued or unfinished posts still go to it: " +
      "remove it from their targets first. Finished posts lose that destination from their history.",
    request: { params: AccountIdParam },
    responses: { 200: json(OkSchema, "Disconnected."), 404: E404, 409: E409 },
  }),
  (c) => {
    deleteAccount(c.req.valid("param").id);
    return c.json({ ok: true as const }, 200);
  },
);

// Queue & schedule

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/queue",
    tags: ["Queue"],
    operationId: "getQueue",
    summary: "Day-by-day queue with free slots",
    description:
      "Timeline starting today (configured timezone): queued, due, failed and published posts plus open slots, grouped by local day. " +
      "Overdue `due`/`failed` posts from earlier days appear on today.",
    request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).default(14).openapi({ description: "Days to include (default 14)." }) }) },
    responses: { 200: json(QueueSchema, "The queue."), 400: E400 },
  }),
  (c) => c.json(buildQueue(c.req.valid("query").days), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/slots/next",
    tags: ["Queue"],
    operationId: "nextSlots",
    summary: "Preview the next free posting slots",
    description: 'The instants `"next"` would pick, in order. A slot is free when no post is scheduled in that minute.',
    request: { query: z.object({ count: z.coerce.number().int().min(1).max(50).default(5) }) },
    responses: { 200: json(z.object({ slots: z.array(z.iso.datetime()) }), "Free slots (UTC)."), 400: E400 },
  }),
  (c) => c.json({ slots: nextFreeSlots(c.req.valid("query").count).map((d) => d.toISOString()) }, 200),
);

// System

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/config",
    tags: ["System"],
    operationId: "getConfig",
    summary: "Read the scheduling config",
    description:
      "Timezone and posting slots from yaypost.config.json (PUT /config/timezone and /config/slots change them; edits to the file apply too). " +
      "If an edit is invalid, the previous config stays in use and `configError` says what is wrong.",
    responses: { 200: json(ConfigSchema, "Current config.") },
  }),
  (c) => {
    const { voice, ...config } = getConfig();
    return c.json({ ...config, voiceCount: voice.length, configError }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "put",
    path: "/config/slots",
    tags: ["System"],
    operationId: "updateSlots",
    summary: "Replace the posting slots",
    description:
      "Writes `slots` in yaypost.config.json (the rest of the file stays as it is). Each rule is `{days, times}` or `{days, from, to, everyMinutes}`; " +
      'days like "mon-fri", "sat,sun" or "daily", times as HH:MM in the configured timezone. Posts already scheduled keep their times. Only the person (owner).',
    request: { body: { content: { "application/json": { schema: z.object({ slots: ConfigSchema.shape.slots }) } } } },
    responses: {
      200: json(ConfigSchema, "Saved; the new config."),
      400: json(ErrorSchema, "Invalid slots."),
      403: json(ErrorSchema, "Only the person (owner) can change the slots."),
    },
  }),
  (c) => {
    requireOwner("change the posting slots");
    const { slots } = c.req.valid("json");
    const { voice, ...config } = writeConfig((raw) => void (raw.slots = slots));
    return c.json({ ...config, voiceCount: voice.length, configError }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "put",
    path: "/config/timezone",
    tags: ["System"],
    operationId: "updateTimezone",
    summary: "Change the timezone",
    description:
      "Writes `timezone` (an IANA name) in yaypost.config.json. Posting slots and the digest are wall-clock times, " +
      "so they follow the new timezone; posts already scheduled keep their exact moment. Only the person (owner).",
    request: { body: { content: { "application/json": { schema: z.object({ timezone: z.string().min(1) }) } } } },
    responses: {
      200: json(ConfigSchema, "Saved; the new config."),
      400: json(ErrorSchema, "Unknown timezone."),
      403: json(ErrorSchema, "Only the person (owner) can change the timezone."),
    },
  }),
  (c) => {
    requireOwner("change the timezone");
    const { timezone } = c.req.valid("json");
    const { voice, ...config } = writeConfig((raw) => void (raw.timezone = timezone.trim()));
    return c.json({ ...config, voiceCount: voice.length, configError }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/health",
    tags: ["System"],
    operationId: "getHealth",
    summary: "Server status and capabilities",
    description:
      "Call first: tells you the timezone and whether publishing is paused. Where posts can go: GET /accounts.",
    responses: { 200: json(HealthSchema, "OK.") },
  }),
  (c) => {
    const health: Health = {
      ok: true,
      version: VERSION,
      timezone: getConfig().timezone,
      paused: Boolean(pauseState()),
      auth: { required: Boolean(env.authToken) },
    };
    return c.json(health, 200);
  },
);

// Media

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/media",
    tags: ["Media"],
    operationId: "uploadMedia",
    summary: "Upload an image",
    description:
      "multipart/form-data with field `file` (PNG, JPEG, WebP or GIF, max 5 MB; the bytes are checked, not the filename) and optional `alt`. " +
      "Attach the returned id via a segment's `mediaIds` (max 4 per post).",
    request: {
      headers: IdemHeader,
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.instanceof(File, { message: "attach the image as multipart field `file`" }).openapi({ type: "string", format: "binary" }),
              alt: z.string().max(1000).optional().openapi({ description: "Alt text (X allows up to 1000 characters)." }),
            }),
          },
        },
      },
    },
    responses: { 201: json(MediaSchema, "The stored image."), 400: E400 },
  }),
  async (c) => {
    const { file, alt } = c.req.valid("form");
    if (file.size > MAX_IMAGE_BYTES) throw new BadInputError(`Image is larger than X's ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);
    return c.json(saveImage({ data: new Uint8Array(await file.arrayBuffer()), declared: file.type, filename: file.name, alt }), 201);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/media/from-url",
    tags: ["Media"],
    operationId: "uploadMediaFromUrl",
    summary: "Import an image from a URL",
    description: "The server downloads the image (http/https only, 15 s timeout, max 5 MB, PNG/JPEG/WebP/GIF) and stores it like an upload.",
    request: {
      headers: IdemHeader,
      body: body(
        z.object({
          url: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
          alt: z.string().max(1000).optional(),
        }),
      ),
    },
    responses: { 201: json(MediaSchema, "The stored image."), 400: E400 },
  }),
  async (c) => {
    const { url, alt } = c.req.valid("json");
    return c.json(await saveImageFromUrl(url, alt), 201);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/media/{id}",
    tags: ["Media"],
    operationId: "getMedia",
    summary: "Get an image's metadata",
    description: "Filename, type, size and alt text. The bytes themselves are served at the returned `url` (/media/{id}).",
    request: { params: IdParam },
    responses: { 200: json(MediaSchema, "The image's metadata."), 404: E404 },
  }),
  (c) => {
    const id = c.req.valid("param").id;
    const m = getMedia(id);
    if (!m) throw new NotFoundError(`Media ${id} not found`);
    const { id: mid, filename, mime, size, alt, url, createdAt } = m;
    return c.json({ id: mid, filename, mime, size, alt, url, createdAt }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/media/{id}",
    tags: ["Media"],
    operationId: "updateMedia",
    summary: "Set an image's alt text",
    description: "Alt text is sent with the image where the platform supports it. null clears it.",
    request: { params: IdParam, body: body(z.object({ alt: z.string().max(1000).nullable() })) },
    responses: { 200: json(MediaSchema, "The updated image."), 400: E400, 404: E404 },
  }),
  (c) => c.json(updateMediaAlt(c.req.valid("param").id, c.req.valid("json").alt), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/media/{id}",
    tags: ["Media"],
    operationId: "deleteMedia",
    summary: "Delete an image",
    description: "Removes the file. Remove its id from posts' mediaIds first, or publishing those posts will fail.",
    request: { params: IdParam },
    responses: { 200: json(OkSchema, "Deleted."), 404: E404 },
  }),
  (c) => {
    deleteMedia(c.req.valid("param").id);
    return c.json({ ok: true as const }, 200);
  },
);

// Events

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/events",
    tags: ["Events"],
    operationId: "streamEvents",
    summary: "Live event stream (Server-Sent Events)",
    description:
      "Streams every state change as SSE: `event:` is the AppEvent type (post.created, post.updated, post.scheduled, post.due, post.published, " +
      "post.failed, post.deleted) and `data:` the AppEvent JSON. A `: ping` comment arrives every 25 s. EventSource can't send headers, " +
      "so authenticate with the yaypost_token cookie or `?token=`. For server-to-server delivery use webhooks.",
    responses: {
      200: { description: "text/event-stream of AppEvent.", content: { "text/event-stream": { schema: z.string() } } },
    },
  }),
  (c) => eventStream(c),
);

// Webhooks

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/webhooks",
    tags: ["Webhooks"],
    operationId: "listWebhooks",
    summary: "List webhook subscriptions",
    description: "Includes the result of each webhook's latest delivery (lastStatus/lastError/lastAt). Secrets are never returned here.",
    responses: { 200: json(z.object({ webhooks: z.array(WebhookSchema) }), "Subscriptions.") },
  }),
  (c) => c.json({ webhooks: listWebhooks() }, 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/webhooks",
    tags: ["Webhooks"],
    operationId: "createWebhook",
    summary: "Subscribe a URL to events",
    description:
      "Yaypost POSTs a WebhookDelivery JSON body to `url` for each matching event (default: all). " +
      "Verify `X-Yaypost-Signature: sha256=<hex>` = HMAC-SHA256 of the raw body keyed with the returned `secret` (shown only once). " +
      "Non-2xx answers or no answer within 10 s are retried twice (after 2 s and 10 s); 4xx other than 408/429 are not retried.",
    request: {
      headers: IdemHeader,
      body: body(
        z.object({
          url: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
          events: z.array(EventType).min(1).optional().openapi({ description: "Event types to receive; omit for all." }),
          format: z.enum(WEBHOOK_FORMATS).optional().openapi({ description: "Omit to pick from the URL (Slack and Discord incoming webhooks get chat messages)." }),
        }),
      ),
    },
    responses: { 201: json(WebhookCreatedSchema, "The subscription, with its secret."), 400: E400 },
  }),
  (c) => c.json(createWebhook(c.req.valid("json")), 201),
);

apiRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/webhooks/{id}",
    tags: ["Webhooks"],
    operationId: "deleteWebhook",
    summary: "Unsubscribe a webhook",
    request: { params: IdParam },
    responses: { 200: json(OkSchema, "Deleted."), 404: E404 },
  }),
  (c) => {
    deleteWebhook(c.req.valid("param").id);
    return c.json({ ok: true as const }, 200);
  },
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/{id}/test",
    tags: ["Webhooks"],
    operationId: "testWebhook",
    summary: "Send a test ping",
    description:
      "Delivers one signed `ping` (data: { webhookId, message }) without retries and reports how the endpoint answered. Use it to check reachability and signature verification.",
    request: { params: IdParam, headers: IdemHeader },
    responses: {
      200: json(WebhookResultSchema, "Delivery result (ok false is still a 200)."),
      404: E404,
    },
  }),
  async (c) => c.json(await testWebhook(c.req.valid("param").id), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/webhooks/{id}",
    tags: ["Webhooks"],
    operationId: "updateWebhook",
    summary: "Change, pause or resume a webhook",
    description: "Same id and secret. Changing the URL re-picks the format from it unless `format` is given.",
    request: {
      params: IdParam,
      body: body(
        z.object({
          url: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }).optional(),
          events: z.array(EventType).min(1).optional(),
          enabled: z.boolean().optional(),
          format: z.enum(WEBHOOK_FORMATS).optional(),
        }),
      ),
    },
    responses: { 200: json(WebhookSchema, "The webhook."), 400: E400, 404: E404 },
  }),
  (c) => c.json(updateWebhook(c.req.valid("param").id, c.req.valid("json")), 200),
);

apiRoutes.openapi(
  createRoute({
    method: "get",
    path: "/webhooks/{id}/deliveries",
    tags: ["Webhooks"],
    operationId: "listWebhookDeliveries",
    summary: "Recent deliveries",
    description: "The last 50 deliveries to this webhook, newest first, with the body sent and the start of each answer.",
    request: { params: IdParam },
    responses: { 200: json(z.object({ deliveries: z.array(DeliveryLogSchema) }), "Deliveries."), 404: E404 },
  }),
  (c) => c.json({ deliveries: listDeliveries(c.req.valid("param").id) }, 200),
);

apiRoutes.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/{id}/deliveries/{deliveryId}/resend",
    tags: ["Webhooks"],
    operationId: "resendWebhookDelivery",
    summary: "Send a delivery again",
    description: "Re-sends the exact body of a logged delivery once (a new delivery in the log; json bodies keep their original id, so receivers can dedupe).",
    request: { params: z.object({ id: z.string(), deliveryId: z.string() }) },
    responses: { 200: json(WebhookResultSchema, "Delivery result (ok false is still a 200)."), 404: E404 },
  }),
  async (c) => {
    const { id, deliveryId } = c.req.valid("param");
    return c.json(await resendDelivery(id, deliveryId), 200);
  },
);

// ---------- /media/:id (outside /api; <img src> friendly) ----------

export const mediaFileRoutes = new Hono();

mediaFileRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const media = getMedia(id);
  const bytes = media && (await readFile(media.path).catch(() => undefined));
  if (!media || !bytes) throw new NotFoundError(`Media ${id} not found`);
  return c.body(bytes, 200, {
    "Content-Type": media.mime,
    // private: a shared cache in front must not serve token-protected or expired signed links to others.
    "Cache-Control": "private, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
});
