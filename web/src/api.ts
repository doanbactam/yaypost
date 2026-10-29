// Typed client for the Yaypost REST API (same origin). Auth token lives in localStorage + a cookie for <img>/SSE.
import type { PlatformInfo, SettingField, ThreadMode } from "../../server/plugin-api.ts";
import type {
  Account,
  AppEventType,
  AuditEntry,
  ChannelStatus,
  ControlState,
  Feedback,
  Health,
  Media,
  OperatorRun,
  OperatorSettings,
  OperatorStatus,
  PlatformId,
  Post,
  PostStatus,
  Queue,
  Segment,
} from "../../shared/types.ts";
import type { WebhookFormat } from "../../shared/webhooks.ts";

export type { CredentialField, SettingField, ThreadMode } from "../../server/plugin-api.ts";
export type { WebhookFormat };
/** A platform as GET /api/platforms serves it (declared by its plugin). */
export type Platform = PlatformInfo & { hasMetrics: boolean };
/** A plugin as GET /api/plugins lists it. */
export interface PluginInfo {
  name: string;
  version: string;
  description: string | null;
  /** built-in: plugins/ · data: <DATA_DIR>/plugins/ · config: plugins.load · installed: from the UI or API. */
  source: "built-in" | "data" | "config" | "installed";
  platforms: string[];
  channels: string[];
  /** Why it isn't loaded; null when it is. */
  error: string | null;
  disabled: boolean;
  /** Switched off in yaypost.config.json (plugins.disable); the UI can't switch it on. */
  disabledByConfig: boolean;
  /** A newer version is installed; it runs after a restart. */
  restartRequired: boolean;
  /** What it was installed from (installed plugins only). */
  spec: string | null;
  /** It declares settings (GET /plugins/settings). */
  hasSettings: boolean;
  /** Required settings with no value yet. */
  settingsMissing: string[];
}
export type SettingValue = string | number | boolean | null;
export type SettingSource = "saved" | "config" | "env" | "default" | "unset";
export interface PluginSettings {
  name: string;
  fields: SettingField[];
  /** Non-secret values only. */
  values: Record<string, SettingValue>;
  sources: Record<string, SettingSource>;
  missing: string[];
}
export interface PluginsState {
  plugins: PluginInfo[];
  apiVersion: number;
  /** npm is available, so plugins can be installed from here. */
  canInstall: boolean;
  restartRequired: boolean;
}
export interface CatalogPackage {
  name: string;
  version: string;
  description: string | null;
  date: string | null;
  publisher: string | null;
  npmUrl: string;
  repositoryUrl: string | null;
  installed: boolean;
}

const TOKEN_KEY = "yaypost_token";

export const auth = {
  get token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; path=/; SameSite=Strict; max-age=31536000${secure}`;
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    document.cookie = `${TOKEN_KEY}=; path=/; SameSite=Strict; max-age=0`;
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

async function call<T>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Yaypost-Source": "ui", ...opts.headers };
  const token = auth.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, keepalive: opts.keepalive });
  } catch {
    throw new ApiError(0, "network", "Can't reach the Yaypost server");
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event("yaypost:unauthorized"));
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "error", err.message ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export type ThreadInput = Pick<Segment, "id" | "text" | "mediaIds">[];
/** A destination as saved with a post: its own version of the thread, or null for the shared one. */
export interface TargetInput {
  accountId: string;
  thread?: ThreadInput | null;
}
export interface PreviewTarget {
  accountId: string | null;
  platform: PlatformId;
  label: string;
  limit: number;
  threadMode: ThreadMode;
  items: { text: string; count: number; fits: boolean; images: number }[];
  problem: string | null;
}
export type PostDetail = Post & { attempts: { at: string; ok: boolean; detail: string | null }[] };
export interface ThreadExport {
  text: string;
  posts: string[];
  intentUrl: string;
  /** Posts already on X (an API publish stopped partway); the rest are remainingPosts, replies under replyToUrl. */
  alreadyLive: number;
  remainingText: string;
  remainingPosts: string[];
  replyToUrl: string | null;
}
export type SlotRule = { days: string; times: string[] } | { days: string; from: string; to: string; everyMinutes: number };
export interface ModelChoice {
  provider: "anthropic" | "zai";
  model: string;
}
/** GET /api/operator/models: what the next run uses, the .env default, and the providers that have a key. */
export interface OperatorModels {
  current: ModelChoice | null;
  default: ModelChoice | null;
  overridden: boolean;
  providers: { id: ModelChoice["provider"]; name: string; configured: boolean; models: string[] }[];
}
export interface AppConfig {
  timezone: string;
  maxChars: number;
  slots: SlotRule[];
  schedulerIntervalSeconds: number;
  lateGraceMinutes: number;
  voiceCount: number;
  /** Why the latest edit of yaypost.config.json was rejected (the previous config stays in use). */
  configError: string | null;
}
export interface WebhookDelivery {
  id: string;
  type: string;
  at: string;
  attempts: number;
  ok: boolean;
  status: number | null;
  error: string | null;
  body: string;
  response: string | null;
}
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

/** Same formula as the server's export: X web intent prefilled with the first post (optionally as a reply). */
export const intentUrl = (firstPost: string, inReplyTo?: string) =>
  `https://x.com/intent/post?text=${encodeURIComponent(firstPost)}${inReplyTo ? `&in_reply_to=${inReplyTo}` : ""}`;

/** "Post 1 is already live on X" / "Posts 1–3 are already live on X". */
export const liveSummary = (live: number) => `${live === 1 ? "Post 1 is" : `Posts 1–${live} are`} already live on X`;

/**
 * What is left to post by hand. When an API publish stopped partway, the first `live` posts are already on X:
 * only the rest should be posted, as replies under the last live one (mirrors GET /posts/{id}/export).
 */
export function remainingThread(post: Post) {
  const live = Math.min(post.xPostIds.length, post.thread.length);
  const lastId = live ? post.xPostIds[live - 1]! : null;
  const rest = post.thread.slice(live);
  return {
    live,
    rest,
    replyToUrl: lastId ? `https://x.com/i/status/${lastId}` : null,
    intent: intentUrl(rest[0]?.text ?? "", lastId ?? undefined),
  };
}

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
};

export const api = {
  health: () => call<Health>("GET", "/api/health"),
  config: () => call<AppConfig>("GET", "/api/config"),
  saveSlots: (slots: SlotRule[]) => call<AppConfig>("PUT", "/api/config/slots", { body: { slots } }),
  saveTimezone: (timezone: string) => call<AppConfig>("PUT", "/api/config/timezone", { body: { timezone } }),

  listPosts: (opts: { status?: PostStatus[]; limit?: number } = {}) =>
    call<{ posts: Post[] }>("GET", `/api/posts${q({ status: opts.status?.join(","), limit: opts.limit })}`).then((r) => r.posts),
  getPost: (id: string) => call<PostDetail>("GET", `/api/posts/${id}`),
  createPost: (body: { thread: ThreadInput; scheduledAt?: string; targets?: TargetInput[] }, idempotencyKey?: string, keepalive?: boolean) =>
    call<Post>("POST", "/api/posts", { body, keepalive, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} }),
  updatePost: (id: string, body: { thread?: ThreadInput; targets?: TargetInput[] }, keepalive?: boolean) =>
    call<Post>("PATCH", `/api/posts/${id}`, { body, keepalive }),
  deletePost: (id: string) => call<{ ok: true }>("DELETE", `/api/posts/${id}`),
  schedule: (id: string, at: string) => call<Post>("POST", `/api/posts/${id}/schedule`, { body: { at } }),
  unschedule: (id: string) => call<Post>("POST", `/api/posts/${id}/unschedule`),
  publish: (id: string) => call<Post>("POST", `/api/posts/${id}/publish`),
  retry: (id: string) => call<Post>("POST", `/api/posts/${id}/retry`),
  markPublished: (id: string, url?: string) => call<Post>("POST", `/api/posts/${id}/mark-published`, { body: url ? { url } : {} }),
  exportPost: (id: string) => call<ThreadExport>("GET", `/api/posts/${id}/export`),
  duplicate: (id: string) => call<Post>("POST", `/api/posts/${id}/duplicate`),
  preview: (id: string) => call<{ targets: PreviewTarget[] }>("GET", `/api/posts/${id}/preview`).then((r) => r.targets),

  platforms: () => call<{ platforms: Platform[] }>("GET", "/api/platforms").then((r) => r.platforms),
  plugins: () => call<PluginsState>("GET", "/api/plugins"),
  pluginCatalog: (query = "") => call<{ keyword: string; packages: CatalogPackage[] }>("GET", `/api/plugins/catalog${q({ q: query.trim() })}`),
  installPlugin: (spec: string) => call<PluginsState & { plugin: PluginInfo }>("POST", "/api/plugins/install", { body: { spec } }),
  installPluginFile: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return call<PluginsState & { plugin: PluginInfo }>("POST", "/api/plugins/install-file", { body: form });
  },
  pluginAction: (action: "enable" | "disable" | "update" | "uninstall", name: string) =>
    call<PluginsState>("POST", `/api/plugins/${action}`, { body: { name } }),
  pluginSettings: (name: string) => call<PluginSettings>("GET", `/api/plugins/settings${q({ name })}`),
  savePluginSettings: (name: string, values: Record<string, SettingValue>) =>
    call<PluginSettings & { plugin: PluginInfo }>("POST", "/api/plugins/settings", { body: { name, values } }),
  restart: () => call<{ restarting: true }>("POST", "/api/system/restart"),
  accounts: () => call<{ accounts: Account[] }>("GET", "/api/accounts").then((r) => r.accounts),
  connectAccount: (body: { platform: PlatformId; credentials: Record<string, string>; label?: string; maxChars?: number }) =>
    call<Account>("POST", "/api/accounts", { body }),
  updateAccount: (id: string, body: { label?: string; maxChars?: number | null }) => call<Account>("PATCH", `/api/accounts/${id}`, { body }),
  checkAccount: (id: string) => call<Account>("POST", `/api/accounts/${id}/check`),
  deleteAccount: (id: string) => call<{ ok: true }>("DELETE", `/api/accounts/${id}`),

  queue: (days = 14) => call<Queue>("GET", `/api/queue?days=${days}`),
  nextSlots: (count = 5) => call<{ slots: string[] }>("GET", `/api/slots/next?count=${count}`).then((r) => r.slots),

  uploadMedia: (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return call<Media>("POST", "/api/media", { body: form });
  },
  /** Metadata such as alt text; null when the image no longer exists. */
  getMedia: (id: string) =>
    call<Media>("GET", `/api/media/${id}`).catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }),
  updateMediaAlt: (id: string, alt: string | null) => call<Media>("PATCH", `/api/media/${id}`, { body: { alt } }),

  webhooks: () => call<{ webhooks: Webhook[] }>("GET", "/api/webhooks").then((r) => r.webhooks),
  createWebhook: (url: string, events?: AppEventType[]) =>
    call<Webhook & { secret: string }>("POST", "/api/webhooks", { body: { url, events } }),
  updateWebhook: (id: string, patch: Partial<Pick<Webhook, "url" | "events" | "enabled" | "format">>) =>
    call<Webhook>("PATCH", `/api/webhooks/${id}`, { body: patch }),
  webhookDeliveries: (id: string) => call<{ deliveries: WebhookDelivery[] }>("GET", `/api/webhooks/${id}/deliveries`).then((r) => r.deliveries),
  resendDelivery: (id: string, deliveryId: string) =>
    call<{ ok: boolean; status: number | null; error: string | null }>("POST", `/api/webhooks/${id}/deliveries/${deliveryId}/resend`),
  deleteWebhook: (id: string) => call<{ ok: true }>("DELETE", `/api/webhooks/${id}`),
  testWebhook: (id: string) => call<{ ok: boolean; status: number | null; error: string | null }>("POST", `/api/webhooks/${id}/test`),

  pushPublicKey: () => call<{ publicKey: string }>("GET", "/api/push/public-key").then((r) => r.publicKey),
  pushSubscribe: (sub: PushSubscriptionJSON) => call<{ ok: true }>("POST", "/api/push/subscribe", { body: sub }),
  pushUnsubscribe: (endpoint: string) => call<{ ok: true }>("POST", "/api/push/unsubscribe", { body: { endpoint } }),
  pushTest: () => call<{ ok: true; message: string }>("POST", "/api/push/test"),


  // The person's side: approvals, the kill switch, the audit log, approval chats, the built-in operator.
  control: () => call<ControlState>("GET", "/api/control"),
  approvals: () => call<{ posts: Post[] }>("GET", "/api/approvals").then((r) => r.posts),
  approve: (id: string, note?: string) => call<Post>("POST", `/api/posts/${id}/approve`, { body: note ? { note } : {} }),
  reject: (id: string, note?: string) => call<Post>("POST", `/api/posts/${id}/reject`, { body: note ? { note } : {} }),
  requestChanges: (id: string, note: string) => call<Post>("POST", `/api/posts/${id}/request-changes`, { body: { note } }),
  pause: (reason?: string) => call<ControlState>("POST", "/api/control/pause", { body: reason ? { reason } : {} }),
  resume: () => call<ControlState>("POST", "/api/control/resume"),
  audit: (opts: { limit?: number; postId?: string } = {}) =>
    call<{ entries: AuditEntry[] }>("GET", `/api/audit${q({ limit: opts.limit, postId: opts.postId })}`).then((r) => r.entries),
  feedback: (limit = 50) => call<{ feedback: Feedback[] }>("GET", `/api/feedback${q({ limit })}`).then((r) => r.feedback),
  forgetFeedback: (id: number) => call<{ ok: true }>("DELETE", `/api/feedback/${id}`),
  restoreFeedback: (id: number) => call<{ ok: true }>("POST", `/api/feedback/${id}/restore`),
  digest: () => call<{ text: string }>("GET", "/api/digest").then((r) => r.text),
  testChannels: (digest?: boolean) =>
    call<{ channels: ChannelStatus[] }>("POST", "/api/channels/test", { body: digest ? { digest } : {} }).then((r) => r.channels),
  operatorStatus: () => call<OperatorStatus>("GET", "/api/operator/status"),
  operatorModels: () => call<OperatorModels>("GET", "/api/operator/models"),
  setOperatorModel: (choice: ModelChoice) => call<OperatorModels>("PUT", "/api/operator/model", { body: choice }),
  resetOperatorModel: () => call<OperatorModels>("DELETE", "/api/operator/model"),
  operatorRuns: (limit = 10) => call<{ runs: OperatorRun[] }>("GET", `/api/operator/runs?limit=${limit}`).then((r) => r.runs),
  runOperator: (task?: string) => call<OperatorRun>("POST", "/api/operator/run", { body: task ? { task } : {} }),
  stopOperatorRun: (id: string) => call<void>("POST", `/api/operator/runs/${id}/stop`),
  operatorSettings: () => call<OperatorSettings>("GET", "/api/operator/settings"),
  saveOperatorSettings: (body: Partial<Omit<OperatorSettings, "briefMissing">>) => call<OperatorSettings>("PUT", "/api/operator/settings", { body }),
};
