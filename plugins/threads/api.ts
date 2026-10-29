// Threads (Meta) via the Threads Graph API. Checked 2026-10 against developers.facebook.com/documentation/threads:
// posts.md, reference/publishing.md, retrieve-and-manage-replies/create-replies.md, posts/accessibility.md,
// threads-profiles.md, reference/media-retrieval.md, troubleshooting.md, overview.md (limits).
// Flow per item: create a container (TEXT, IMAGE, or IMAGE children + CAROUSEL), poll GET /{container}?fields=status
// until FINISHED, POST /{user-id}/threads_publish {creation_id}, then the next item replies with reply_to_id.
// Meta fetches images itself from image_url, so they are served via ts.media.publicUrl (signed, valid an hour) on a public HTTPS PUBLIC_URL.
// Images: JPEG/PNG only, alt_text on each image container. Limits: 250 posts + 1,000 replies per 24h per profile.
// Metrics: GET /{threads-media-id}/insights?metric=views,likes,replies,reposts,quotes (insights.md, checked
// 2026-10-29 at developers.facebook.com/docs/threads/insights) needs threads_basic + threads_manage_insights; returns
// {data: [{name, period: "lifetime", values: [{value}], id}]}; replies of a root post count all its replies, and nested
// replies' metrics are not included. `views` is marked "in development" by Meta.
import type { Credentials, ItemMetrics, PlatformDefinition, PublishItem, YaypostAPI } from "yaypost/plugin";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

/** verify/publish/metrics, bound to this plugin's `ts`. */
export function createThreads(ts: YaypostAPI): Pick<PlatformDefinition, "verify" | "publish" | "metrics"> {
  const apiBase = () => (ts.env("THREADS_API_BASE") ?? "https://graph.threads.com/v1.0").replace(/\/+$/, "");
  const TIMEOUT_MS = 60_000;
  const POLL_LIMIT_MS = 5 * 60_000;
  const IMAGE_MIMES = new Set(["image/jpeg", "image/png"]);
  const TOKEN_FIX =
    "Generate a new long-lived access token for your Meta app (developers.facebook.com → your app → Threads use case; tokens last 60 days unless refreshed) and paste it into this account's credentials, then Retry.";

  interface GraphError {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** PlatformError that keeps the Graph error code, so callers can tell "no such post" from other failures. */
  class GraphPlatformError extends ts.PlatformError {
    constructor(
      base: PlatformError,
      readonly graph: GraphError | undefined,
    ) {
      super(base.message, base.status, base.resumable);
    }
  }

  function explain(status: number, e: GraphError | undefined, raw: string): PlatformError {
    return new GraphPlatformError(explainBase(status, e, raw), e);
  }

  function explainBase(status: number, e: GraphError | undefined, raw: string): PlatformError {
    const detail = e?.error_user_msg || e?.message || raw.trim().slice(0, 200) || `HTTP ${status}`;
    const code = e?.code;
    if (code === 190 || status === 401) return new ts.PlatformError(`Threads rejected the access token (${detail}). ${TOKEN_FIX}`, 401);
    if (code === 10 || (code !== undefined && code >= 200 && code < 300) || status === 403) {
      return new ts.PlatformError(
        `Threads refused: the token lacks a permission (${detail}). The app needs threads_basic, threads_content_publish and threads_manage_replies (for the thread's replies); regenerate the token with them, update the account, then Retry.`,
        403,
      );
    }
    if (status === 429 || [4, 17, 32, 613].includes(code ?? 0)) {
      return new ts.PlatformError(
        `Threads rate limit reached (${detail}). Profiles may publish 250 posts and 1,000 replies per rolling 24 hours; Retry in an hour or two.`,
        429,
      );
    }
    if (status >= 500) return new ts.PlatformError(`Threads API error ${status} (${detail}). Usually temporary: Retry in a few minutes.`, status);
    return new ts.PlatformError(`Threads rejected the request (${status}: ${detail}).`, status);
  }

  async function call<T>(method: "GET" | "POST", path: string, token: string, params: Record<string, string> = {}): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: token });
    const url = apiBase() + path + (method === "GET" ? `?${body}` : "");
    let res: Response;
    try {
      res = await fetch(url, { method, body: method === "POST" ? body : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        const next = method === "GET" ? "Try again in a minute." : "it may have gone through, so check your profile before you Retry.";
        throw new ts.PlatformError(`Threads didn't answer ${method} ${path} within ${TIMEOUT_MS / 1000}s; ${next}`);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ts.PlatformError(`Couldn't reach the Threads API at ${apiBase()} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the server's internet connection, then Retry.`);
    }
    const raw = await res.text();
    let json: (T & { error?: GraphError }) | undefined;
    try {
      json = JSON.parse(raw);
    } catch {
      json = undefined;
    }
    if (!res.ok || json?.error) throw explain(res.status, json?.error, raw);
    if (!json) throw new ts.PlatformError(`Threads answered ${res.status} with a non-JSON body: ${raw.slice(0, 200)}`, res.status);
    return json;
  }

  const token = (c: Credentials) => {
    if (!c.accessToken) throw new ts.PlatformError(`No Threads access token is stored. ${TOKEN_FIX}`, 401, false);
    return c.accessToken;
  };

  /** Meta downloads images from our server, so PUBLIC_URL must be a public https origin. */
  function requirePublicUrl(): void {
    const why = (() => {
      const { publicUrl, publicUrlIsSet } = ts.host();
      if (!publicUrlIsSet) return "PUBLIC_URL is not set";
      const u = new URL(publicUrl);
      if (u.protocol !== "https:") return `PUBLIC_URL (${publicUrl}) is not https`;
      const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h === "0.0.0.0" || /^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
        return `PUBLIC_URL (${publicUrl}) is not reachable from the internet`;
      }
    })();
    if (why) {
      throw new ts.PlatformError(
        `Threads fetches images from this server by URL, but ${why}. Set PUBLIC_URL in .env to this server's public https address (e.g. via a reverse proxy or tunnel) and restart, or remove the images from the Threads version, then Retry.`,
        400,
      );
    }
  }

  /** Check every image of the remaining items before anything is posted. */
  function checkImages(items: PublishItem[]): void {
    if (!items.some((i) => i.mediaIds.length)) return;
    requirePublicUrl();
    for (const [n, item] of items.entries()) {
      if (item.mediaIds.length > 20) throw new ts.PlatformError(`Post ${n + 1} has ${item.mediaIds.length} images; a Threads carousel holds at most 20.`, 400, false);
      for (const id of item.mediaIds) {
        const m = ts.media.get(id);
        if (!m) throw new ts.PlatformError(`An image of post ${n + 1} was deleted; remove it from the post, then Retry.`, 400);
        if (!IMAGE_MIMES.has(m.mime)) {
          throw new ts.PlatformError(`Threads accepts only JPEG and PNG images; "${m.filename}" (post ${n + 1}) is ${m.mime}. Convert or replace it, then Retry.`, 400);
        }
      }
    }
  }

  async function waitFinished(container: string, tok: string): Promise<void> {
    const start = Date.now();
    for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
      const s = await call<{ status?: string; error_message?: string }>("GET", `/${container}`, tok, { fields: "status,error_message" });
      if (s.status === "FINISHED" || s.status === "PUBLISHED" || !s.status) return;
      if (s.status === "ERROR") {
        throw new ts.PlatformError(`Threads couldn't process the media (${s.error_message ?? "UNKNOWN"}). Check the images (JPEG/PNG, ≤ 8 MB, 320–1440 px wide, aspect ratio ≤ 10:1) and that PUBLIC_URL serves them, then Retry.`, 400);
      }
      if (s.status === "EXPIRED") throw new ts.PlatformError("The Threads media container expired before publishing; Retry.", 400);
      if (Date.now() - start > POLL_LIMIT_MS) throw new ts.PlatformError(`Threads was still processing the media after ${POLL_LIMIT_MS / 60_000} minutes; Retry later.`);
      await sleep(wait);
    }
  }

  async function imageContainer(id: string, tok: string, extra: Record<string, string>): Promise<string> {
    const m = ts.media.get(id);
    const params: Record<string, string> = { media_type: "IMAGE", image_url: ts.media.publicUrl(id), ...extra };
    if (m?.alt) params.alt_text = m.alt.slice(0, 1000);
    return (await call<{ id: string }>("POST", "/me/threads", tok, params)).id;
  }

  /** Create, wait for and publish one item; returns the published media id. */
  async function publishItem(item: PublishItem, userId: string, tok: string, replyTo: string | undefined): Promise<string> {
    const common: Record<string, string> = {};
    if (item.text.trim()) common.text = item.text;
    if (replyTo) common.reply_to_id = replyTo;
    let container: string;
    if (item.mediaIds.length === 0) {
      container = (await call<{ id: string }>("POST", "/me/threads", tok, { media_type: "TEXT", ...common })).id;
    } else if (item.mediaIds.length === 1) {
      container = await imageContainer(item.mediaIds[0], tok, common);
    } else {
      const children: string[] = [];
      for (const id of item.mediaIds) children.push(await imageContainer(id, tok, { is_carousel_item: "true" }));
      for (const c of children) await waitFinished(c, tok);
      container = (await call<{ id: string }>("POST", "/me/threads", tok, { media_type: "CAROUSEL", children: children.join(","), ...common })).id;
    }
    await waitFinished(container, tok);
    return (await call<{ id: string }>("POST", `/${userId}/threads_publish`, tok, { creation_id: container })).id;
  }

  const INSIGHT_METRICS = { views: "views", likes: "likes", replies: "replies", reposts: "reposts", quotes: "quotes" } as const;
  const INSIGHTS_FIX =
    "Add the threads_manage_insights permission to your Meta app (developers.facebook.com → your app → Threads use case → Permissions), generate a new access token that includes it, update the account's credentials, then try again.";

  interface Insight {
    name?: string;
    values?: { value?: number }[];
    total_value?: { value?: number };
  }

  async function mediaInsights(id: string, tok: string): Promise<ItemMetrics> {
    let res: { data?: Insight[] };
    try {
      res = await call<{ data?: Insight[] }>("GET", `/${encodeURIComponent(id)}/insights`, tok, { metric: Object.keys(INSIGHT_METRICS).join(",") });
    } catch (err) {
      const g = err instanceof GraphPlatformError ? err.graph : undefined;
      if (err instanceof ts.PlatformError && err.status === 403) {
        throw new ts.PlatformError(`Threads won't show insights to this token (${g?.message ?? err.message}). ${INSIGHTS_FIX}`, 403);
      }
      // Code 100 subcode 33: the object doesn't exist (post deleted) or the token can't see it.
      if (g?.code === 100 && g.error_subcode === 33) return { id };
      throw err;
    }
    const m: ItemMetrics = { id };
    for (const d of res.data ?? []) {
      const key = INSIGHT_METRICS[d.name as keyof typeof INSIGHT_METRICS];
      const value = d.total_value?.value ?? d.values?.at(-1)?.value;
      if (key && typeof value === "number") m[key] = value;
    }
    return m;
  }

  return {
    async verify(c) {
      const me = await call<{ id: string; username?: string }>("GET", "/me", token(c), { fields: "id,username" });
      const handle = me.username ? `@${me.username}` : me.id;
      return { handle, profileUrl: me.username ? `https://www.threads.com/@${me.username}` : null };
    },

    async publish(ctx) {
      const tok = token(ctx.credentials);
      const ids = [...ctx.posted];
      checkImages(ctx.items.slice(ids.length));
      const me = await call<{ id: string; username?: string }>("GET", "/me", tok, { fields: "id,username" });
      for (const item of ctx.items.slice(ids.length)) {
        ids.push(await publishItem(item, me.id, tok, ids.at(-1)));
        ctx.record([...ids]);
      }
      let url: string | null = null;
      try {
        url = (await call<{ permalink?: string }>("GET", `/${ids[0]}`, tok, { fields: "permalink" })).permalink ?? null;
      } catch {
        url = me.username ? `https://www.threads.com/@${me.username}` : null; // posted fine; the link is a nicety
      }
      return { ids, url };
    },

    async metrics(ctx) {
      const tok = token(ctx.credentials);
      const out: ItemMetrics[] = new Array(ctx.externalIds.length);
      for (let i = 0; i < ctx.externalIds.length; i += 4) {
        const chunk = ctx.externalIds.slice(i, i + 4);
        (await Promise.all(chunk.map((id) => mediaInsights(id, tok)))).forEach((m, j) => (out[i + j] = m));
      }
      return out;
    },
  };
}
