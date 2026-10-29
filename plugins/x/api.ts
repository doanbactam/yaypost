// X API v2 client: OAuth 1.0a user-context requests, image upload, thread publishing, metrics, verify.
// Publishing resumes: items already in `posted` are skipped, and every new tweet id is reported through record()
// before the next call, so a failure or crash mid-thread never posts the same tweet twice. Content problems X would
// reject (length, empty, too many images) are caught by Yaypost's pre-flight before publish() is called, and images
// are uploaded before the first tweet, so neither can leave a half-posted thread.
// X_API_BASE overrides https://api.x.com (tests).
import { createHash } from "node:crypto";
import type { YaypostAPI } from "yaypost/plugin";
import { oauthHeader, percentEncode, type OAuthCredentials } from "./oauth.ts";

interface XProblem {
  title?: string;
  detail?: string;
  type?: string;
  errors?: { message?: string; detail?: string }[];
}

interface UploadData {
  id: string;
  expires_after_secs?: number;
  processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } };
}

// GET /2/tweets?ids=…&tweet.fields=public_metrics (docs.x.com/x-api/posts/get-posts-by-ids: ids 1–100;
// docs.x.com/x-api/fundamentals/metrics: public_metrics {retweet_count, reply_count, like_count, quote_count,
// bookmark_count, impression_count}, any auth). The API reference also spells it repost_count, so both are read.
// Ids X can't return (deleted, protected) come back in `errors`, not `data`. Billed as Posts: Read ($0.005 per post,
// deduplicated per post per UTC day; docs.x.com/x-api/getting-started/pricing, checked 2026-10-29).
export interface XPublicMetrics {
  like_count?: number;
  retweet_count?: number;
  repost_count?: number;
  reply_count?: number;
  quote_count?: number;
  impression_count?: number;
  bookmark_count?: number;
}

/** What ts.store keeps per uploaded image: X's media id and when X forgets it. */
interface CachedMedia {
  id: string;
  expiresAt: string;
}

function problemText(p: XProblem | undefined): string | undefined {
  if (!p || typeof p !== "object") return undefined;
  const parts = [p.detail, ...(p.errors ?? []).map((e) => e.detail ?? e.message)].filter((s): s is string => Boolean(s));
  return [...new Set(parts)].join("; ") || p.title;
}

function resetHint(h: Headers): string {
  // POST /2/tweets also has 24-hour per-user and per-app caps; name whichever window is exhausted.
  for (const prefix of ["x-user-limit-24hour", "x-app-limit-24hour", "x-rate-limit"]) {
    const reset = Number(h.get(`${prefix}-reset`));
    if (reset && h.get(`${prefix}-remaining`) === "0") return untilText(reset);
  }
  const reset = Number(h.get("x-rate-limit-reset"));
  return reset ? untilText(reset) : "in a few minutes";
}

function untilText(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  const minutes = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 60_000));
  return `after ${at.toISOString().replace(/\.\d+Z$/, "Z")} (in ~${minutes} min)`;
}

/** X's 403 when the tweet being replied to was deleted or is hidden: the thread can't be continued under it. */
const REPLY_TARGET_GONE = /deleted|not visible/i;

/** Turn an X error response into a sentence that says what happened and what to do. */
function explain(status: number, headers: Headers, body: XProblem | undefined, raw: string, method = "POST"): string {
  const detail = problemText(body) ?? (raw.trim().slice(0, 200) || `HTTP ${status}`);
  const haystack = `${body?.type ?? ""} ${detail}`;
  if (method === "GET" && status === 403) {
    return `X refused the read (403: ${detail}). In the X Developer Console, check the app belongs to a project with API access and credits, then try again.`;
  }
  if (status === 401) {
    return `X rejected the API credentials (401: ${detail}). Check X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET in .env (regenerate them in the X Developer Console if revoked) and that this server's clock is correct, then restart and Retry.`;
  }
  if (status === 402 || /credit|payment|billing|usage-capped/i.test(haystack)) {
    return `Your X API account is out of credits or hit its spending cap (${status}: ${detail}). The X API is pay-per-use (about $0.015 per post, $0.20 per post with a link): top up credits in the X Developer Console, then Retry.`;
  }
  if (status === 429) return `X rate limit reached (429: ${detail}). Retry ${resetHint(headers)}.`;
  if (status === 403 && /duplicate/i.test(detail)) {
    return (
      `X refused a duplicate post (403: ${detail}). If an earlier attempt timed out or was interrupted, this post is probably already live: ` +
      `check your profile, and if it is there, post the rest of the thread by hand as replies to it and mark this post published. Otherwise change its text and Retry.`
    );
  }
  if (status === 403 && REPLY_TARGET_GONE.test(detail)) {
    return (
      `X refused the reply (403: ${detail}): the post this thread continues from was deleted or is no longer visible, so Retry can't continue it. ` +
      `Duplicate it into a new draft to post it again, or mark it published if you finished it by hand.`
    );
  }
  if (status === 403 && /client-forbidden|client-not-enrolled|enrol/i.test(haystack)) {
    return `Your X developer app can't use the posting API (403: ${detail}). In the X Developer Console, check the app belongs to a project with API access and has credits, then Retry.`;
  }
  if (status === 403 && /oauth1|permission|not permitted/i.test(haystack)) {
    return `X refused to post (403: ${detail}). The app's permissions must be "Read and write": set it under User authentication settings in the X Developer Console, then regenerate the Access Token and Secret (tokens keep the permissions they were created with), update .env, restart and Retry.`;
  }
  if (status === 403) {
    return `X refused to post (403: ${detail}). Check the post and the account on x.com (reply restrictions, a locked or limited account), then Retry.`;
  }
  if (status === 400) return `X rejected the post (400: ${detail}). Fix the content (too long, empty, bad image?) and Retry.`;
  if (status >= 500) return `X API error ${status} (${detail}). Usually temporary: Retry in a few minutes.`;
  return `X API error ${status}: ${detail}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export function createXClient(ts: YaypostAPI) {
  const apiBase = () => (ts.env("X_API_BASE") ?? "https://api.x.com").replace(/\/+$/, "");

  async function xRequest<T extends { data?: unknown }>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; allowNoData?: boolean },
    creds: OAuthCredentials,
  ): Promise<T> {
    const query = opts.query ? "?" + Object.entries(opts.query).map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join("&") : "";
    const url = apiBase() + path + query;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: oauthHeader(method, url, creds),
          ...(opts.json === undefined ? {} : { "content-type": "application/json" }),
        },
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (err instanceof ts.PlatformError) throw err;
      if ((err as Error).name === "TimeoutError") {
        const next = method === "GET" ? "Try again in a minute." : "it may or may not have gone through, so check your profile before you Retry.";
        throw new ts.PlatformError(`X didn't answer ${method} ${path} within 60s; ${next}`);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ts.PlatformError(
        `Couldn't reach the X API at ${apiBase()} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the server's internet connection, then Retry.`,
      );
    }
    const raw = await res.text();
    let body: (XProblem & { data?: unknown }) | undefined;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      throw new ts.PlatformError(explain(res.status, res.headers, body, raw, method), res.status, !(res.status === 403 && REPLY_TARGET_GONE.test(raw)));
    }
    if (!body?.data && !opts.allowNoData) throw new ts.PlatformError(`X answered ${res.status} without data: ${problemText(body) ?? raw.slice(0, 200)}`, res.status);
    return body as T;
  }

  /**
   * Upload one stored image (or reuse X's media id from an earlier attempt) and return the X media id. The cache is
   * keyed by the account (media ids belong to the uploading user), the image and its alt text.
   */
  async function uploadMedia(mediaId: string, creds: OAuthCredentials): Promise<string> {
    const m = ts.media.get(mediaId);
    if (!m) throw new ts.PlatformError(`Image ${mediaId} no longer exists; remove it from the post and Retry.`);
    const cacheKey = `media:${hash(`${creds.consumerKey}\n${creds.token}`)}:${mediaId}:${hash(m.alt?.trim() ?? "")}`;
    const cached = ts.store.get<CachedMedia>(cacheKey);
    if (cached?.id && Date.parse(cached.expiresAt) > Date.now() + 10 * 60_000) return cached.id;

    let { data } = await xRequest<{ data: UploadData }>(
      "POST",
      "/2/media/upload",
      { json: { media: ts.media.read(mediaId).toString("base64"), media_category: "tweet_image" } },
      creds,
    );
    for (let polls = 0; data.processing_info && ["pending", "in_progress"].includes(data.processing_info.state); polls++) {
      if (polls >= 30) throw new ts.PlatformError(`X is still processing ${m.filename}; Retry in a minute.`);
      await sleep((data.processing_info.check_after_secs ?? 2) * 1000);
      ({ data } = await xRequest<{ data: UploadData }>("GET", "/2/media/upload", { query: { command: "STATUS", media_id: data.id } }, creds));
    }
    if (data.processing_info?.state === "failed") {
      throw new ts.PlatformError(`X couldn't process ${m.filename}: ${data.processing_info.error?.message ?? "unknown error"}. Try another image.`);
    }
    // Cache the X media id only once its alt text is set; otherwise the next attempt uploads again and retries the alt.
    let altSet = true;
    if (m.alt?.trim()) {
      try {
        await xRequest("POST", "/2/media/metadata", { json: { id: data.id, metadata: { alt_text: { text: m.alt.slice(0, 1000) } } } }, creds);
      } catch (err) {
        altSet = false;
        ts.log.warn(`alt text for ${m.filename} not set (posting without it): ${(err as Error).message}`);
      }
    }
    if (altSet) {
      const value: CachedMedia = { id: data.id, expiresAt: new Date(Date.now() + (data.expires_after_secs ?? 86_400) * 1000).toISOString() };
      ts.store.set(cacheKey, value);
    }
    return data.id;
  }

  /** Who the credentials belong to (GET /2/users/me; billed as one owned read, about $0.001). */
  async function verifyX(creds: OAuthCredentials): Promise<{ handle: string; profileUrl: string }> {
    const { data } = await xRequest<{ data: { username: string } }>("GET", "/2/users/me", {}, creds);
    return { handle: `@${data.username}`, profileUrl: `https://x.com/${data.username}` };
  }

  /** Public metrics of the given post ids, in batches of 100; ids X didn't return are missing from the map. */
  async function readPostMetrics(creds: OAuthCredentials, ids: string[]): Promise<Map<string, XPublicMetrics>> {
    const out = new Map<string, XPublicMetrics>();
    const unique = [...new Set(ids.filter((id) => /^\d{1,19}$/.test(id)))];
    for (let i = 0; i < unique.length; i += 100) {
      const { data } = await xRequest<{ data?: { id: string; public_metrics?: XPublicMetrics }[] }>(
        "GET",
        "/2/tweets",
        { query: { ids: unique.slice(i, i + 100).join(","), "tweet.fields": "public_metrics" }, allowNoData: true },
        creds,
      );
      for (const t of data ?? []) out.set(t.id, t.public_metrics ?? {});
    }
    return out;
  }

  /**
   * Post the thread in order, each tweet replying to the previous one. Resumes after `posted`. Errors carry only the
   * cause: the core adds how many items are live and whether Retry continues after them.
   */
  async function publishThreadToX(opts: {
    creds: OAuthCredentials;
    items: { text: string; mediaIds: string[] }[];
    posted: string[];
    record: (ids: string[]) => void;
  }): Promise<{ ids: string[]; url: string }> {
    const { creds } = opts;
    const ids = [...opts.posted];
    const pending = opts.items.slice(ids.length);
    // Length, empty items and image counts were already checked by Yaypost's pre-flight (counting rule x-weighted).
    // Upload every remaining image before the first tweet so a bad image can't leave the thread half-posted.
    const media: string[][] = [];
    for (const s of pending) {
      const xIds: string[] = [];
      for (const id of s.mediaIds) xIds.push(await uploadMedia(id, creds));
      media.push(xIds);
    }
    for (const [i, s] of pending.entries()) {
      const replyTo = ids.at(-1);
      const { data } = await xRequest<{ data: { id: string } }>(
        "POST",
        "/2/tweets",
        {
          json: {
            ...(s.text.trim() ? { text: s.text } : {}),
            ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}),
            ...(media[i]!.length ? { media: { media_ids: media[i] } } : {}),
          },
        },
        creds,
      );
      ids.push(data.id);
      opts.record([...ids]);
    }
    return { ids, url: `https://x.com/i/status/${ids[0]}` };
  }

  return { verifyX, readPostMetrics, publishThreadToX };
}
