// Mastodon REST API with a user access token. Checked 2026-10-29 at docs.joinmastodon.org: methods/accounts
// (GET /api/v1/accounts/verify_credentials needs `profile` or `read:accounts`; 401/403/422 {error}), methods/media
// (POST /api/v2/media multipart file+description → 200 ready or 202 with url null; GET /api/v1/media/:id → 206 while
// processing, 200 when url is set, 422 if processing failed), methods/statuses (POST /api/v1/statuses status,
// media_ids[], in_reply_to_id, visibility; Idempotency-Key header remembered for 1 hour; 422 {error} on validation),
// api/rate-limits (X-RateLimit-Reset; 300 calls / 5 min, media 30 / 30 min).
// Metrics: GET /api/v1/statuses/:id (methods/statuses#get: public statuses need no token since 2.7.0; 401 "This API
// requires an authenticated user" when the instance is in authorized-fetch mode; 404 when deleted or private) →
// Status favourites_count, reblogs_count, replies_count, quotes_count (4.5.0+) (entities/Status). Mastodon checks
// the scope of any token sent (authorize_if_got_token! :read, :'read:statuses' in statuses_controller.rb), so a
// publishing-only token gets 403 there: we then read anonymously, and only ask for read:statuses if that fails too.
import { createHash } from "node:crypto";
import type { Credentials, ItemMetrics, PlatformDefinition, PublishItem, YaypostAPI } from "yaypost/plugin";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

/** verify/publish/metrics, bound to this plugin's `ts`. */
export function createMastodon(ts: YaypostAPI): Pick<PlatformDefinition, "verify" | "publish" | "metrics"> {
  const TOKEN_HELP = "Create a token under your instance → Preferences → Development (scopes profile, write:statuses, write:media) and update the account";

  const instanceUrl = (c: Credentials) => {
    const s = (c.instanceUrl ?? "").trim().replace(/\/+$/, "");
    if (!s) throw new ts.PlatformError("Mastodon needs the instance URL, e.g. https://mastodon.social.", 400, false);
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  };

  function untilText(h: Headers): string {
    const reset = Date.parse(h.get("x-ratelimit-reset") ?? "");
    if (!reset) return "in a few minutes";
    const minutes = Math.max(1, Math.ceil((reset - Date.now()) / 60_000));
    return `after ${new Date(reset).toISOString().replace(/\.\d+Z$/, "Z")} (in ~${minutes} min)`;
  }

  type Kind = "verify" | "media" | "status" | "read";

  function explain(kind: Kind, status: number, headers: Headers, detail: string, replying: boolean): PlatformError {
    if (kind === "read" && (status === 401 || status === 403 || status === 404)) {
      // Read-only metrics: statusMetrics turns these into the right advice (or "deleted").
      return new ts.PlatformError(`Mastodon ${status}: ${detail}`, status);
    }
    if (status === 401) return new ts.PlatformError(`Mastodon rejected the access token (401: ${detail}). ${TOKEN_HELP}, then Retry.`, 401);
    if (status === 403 && /scope/i.test(detail)) {
      const need = kind === "verify" ? "profile (or read:accounts)" : kind === "media" ? "write:media" : "write:statuses";
      return new ts.PlatformError(`The Mastodon token lacks the ${need} scope (403: ${detail}). ${TOKEN_HELP}, then Retry.`, 403);
    }
    if (status === 403) return new ts.PlatformError(`Mastodon refused (403: ${detail}). Check the account on your instance (disabled, unconfirmed or pending approval), then Retry.`, 403);
    if (status === 422 && kind === "verify") return new ts.PlatformError(`Mastodon says this token has no signed-in user (422: ${detail}). ${TOKEN_HELP}.`, 422);
    if (status === 404 && kind === "status" && replying) {
      return new ts.PlatformError(
        `Mastodon couldn't find the post this thread continues from (404: ${detail}); it was probably deleted, so Retry can't continue it. Duplicate the post into a new draft to post it again.`,
        404,
        false,
      );
    }
    if (status === 429) return new ts.PlatformError(`Mastodon rate limit reached (429: ${detail}). Retry ${untilText(headers)}.`, 429);
    if (status === 413) return new ts.PlatformError(`Your Mastodon instance refused an image as too large (413). Use a smaller image, then Retry.`, 413);
    if (status === 422 && kind === "media") return new ts.PlatformError(`Mastodon couldn't accept or process an image (422: ${detail}). Try another image (png, jpeg, webp or gif), then Retry.`, 422);
    if (status === 422) return new ts.PlatformError(`Mastodon rejected the post (422: ${detail}). Fix it (too long for this instance? set the account's character limit), then Retry.`, 422);
    if (status >= 500) return new ts.PlatformError(`Mastodon error ${status} (${detail}). Usually temporary: Retry in a few minutes.`, status);
    return new ts.PlatformError(`Mastodon error ${status}: ${detail}`, status);
  }

  async function api<T>(
    base: string,
    token: string,
    kind: Kind,
    method: "GET" | "POST",
    path: string,
    opts: { json?: unknown; form?: FormData; headers?: Record<string, string>; replying?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.json !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.form,
        signal: AbortSignal.timeout(kind === "media" ? 120_000 : kind === "read" ? 30_000 : 60_000),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        const retry = kind === "status" ? "Retry is safe within an hour (the same request is recognised and not posted twice)." : "Retry in a minute.";
        throw new ts.PlatformError(`Mastodon didn't answer ${method} ${path} in time. ${retry}`);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ts.PlatformError(`Couldn't reach Mastodon at ${base} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the instance URL and the server's internet connection, then Retry.`);
    }
    const raw = await res.text();
    let body: (T & { error?: string; error_description?: string }) | undefined;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const detail = [body?.error, body?.error_description].filter(Boolean).join(": ") || raw.trim().slice(0, 200) || `HTTP ${res.status}`;
      throw explain(kind, res.status, res.headers, detail, Boolean(opts.replying));
    }
    if (!body) throw new ts.PlatformError(`Mastodon answered ${method} ${path} with ${res.status} but no JSON: ${raw.slice(0, 200)}`, res.status);
    return { status: res.status, body };
  }

  interface Attachment {
    id: string;
    url: string | null;
  }
  interface Status {
    id: string;
    url: string | null;
    uri: string;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function uploadImage(base: string, token: string, mediaId: string): Promise<string> {
    const m = ts.media.get(mediaId);
    if (!m) throw new ts.PlatformError(`Image ${mediaId} no longer exists; remove it from the post and Retry.`);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(ts.media.read(mediaId))], { type: m.mime }), m.filename);
    if (m.alt?.trim()) form.append("description", m.alt.trim());
    let { body } = await api<Attachment>(base, token, "media", "POST", "/api/v2/media", { form });
    for (let polls = 0; !body.url; polls++) {
      if (polls >= 30) throw new ts.PlatformError(`Mastodon is still processing ${m.filename}; Retry in a minute.`);
      await sleep(Math.min(1000 * 2 ** Math.min(polls, 2), 4000));
      ({ body } = await api<Attachment>(base, token, "media", "GET", `/api/v1/media/${encodeURIComponent(body.id)}`));
    }
    return body.id;
  }

  /** Same post, same item, same parent → same key, so Mastodon returns the earlier status instead of posting twice. */
  function idempotencyKey(postId: string, accountId: string, items: PublishItem[], index: number, inReplyTo: string | null): string {
    // Only this item: editing later posts after a timeout must not change the key of the one that may have gone out.
    const item = items[index]!;
    const h = createHash("sha256").update(JSON.stringify([postId, accountId, index, inReplyTo, item.text, item.mediaIds]));
    return `yaypost-${h.digest("hex").slice(0, 40)}`;
  }

  interface StatusCounts {
    id: string;
    favourites_count?: number;
    reblogs_count?: number;
    replies_count?: number;
    quotes_count?: number;
  }

  const READ_HELP = "create a token with the read:statuses scope too (instance → Preferences → Development → your app) and update the account";

  /** One status's counts; deleted or no-longer-visible statuses come back without numbers. */
  async function statusMetrics(base: string, token: string, id: string): Promise<ItemMetrics> {
    const path = `/api/v1/statuses/${encodeURIComponent(id)}`;
    const get = (tok: string) => api<StatusCounts>(base, tok, "read", "GET", path).then((r) => r.body);
    let body: StatusCounts;
    try {
      try {
        body = await get(token);
      } catch (err) {
        // A token without read scopes is refused even for public statuses (403); so is a revoked one (401).
        // Anonymous reads work for public posts unless the instance uses authorized fetch.
        if (!(err instanceof ts.PlatformError && (err.status === 403 || err.status === 401) && token)) throw err;
        try {
          body = await get("");
        } catch (anon) {
          if (anon instanceof ts.PlatformError && anon.status === 401) {
            const why = err.status === 401 ? `the access token was rejected (${err.message})` : `the token can't read posts (${err.message})`;
            throw new ts.PlatformError(`This Mastodon instance only shows posts to signed-in apps and ${why}. To see engagement, ${READ_HELP}, then try again.`, err.status);
          }
          throw anon;
        }
      }
    } catch (err) {
      if (err instanceof ts.PlatformError && err.status === 404) return { id };
      throw err;
    }
    const m: ItemMetrics = { id };
    if (typeof body.favourites_count === "number") m.likes = body.favourites_count;
    if (typeof body.reblogs_count === "number") m.reposts = body.reblogs_count;
    if (typeof body.replies_count === "number") m.replies = body.replies_count;
    if (typeof body.quotes_count === "number") m.quotes = body.quotes_count;
    return m;
  }

  return {
    async verify(c) {
      const base = instanceUrl(c);
      const { body } = await api<{ acct: string; username: string; url: string | null }>(base, c.accessToken ?? "", "verify", "GET", "/api/v1/accounts/verify_credentials");
      const acct = body.acct || body.username;
      return { handle: acct.includes("@") ? `@${acct}` : `@${acct}@${new URL(base).host}`, profileUrl: body.url ?? null };
    },

    async publish(ctx) {
      const base = instanceUrl(ctx.credentials);
      const token = ctx.credentials.accessToken ?? "";
      const ids = [...ctx.posted];
      let firstUrl: string | null = null;
      for (let i = ids.length; i < ctx.items.length; i++) {
        const item = ctx.items[i];
        const mediaIds: string[] = [];
        for (const id of item.mediaIds) mediaIds.push(await uploadImage(base, token, id));
        const inReplyTo = ids.length ? ids[ids.length - 1] : null;
        const { body } = await api<Status>(base, token, "status", "POST", "/api/v1/statuses", {
          json: { status: item.text, visibility: "public", ...(mediaIds.length ? { media_ids: mediaIds } : {}), ...(inReplyTo ? { in_reply_to_id: inReplyTo } : {}) },
          headers: { "idempotency-key": idempotencyKey(ctx.postId, ctx.account.id, ctx.items, i, inReplyTo) },
          replying: Boolean(inReplyTo),
        });
        if (i === 0) firstUrl = body.url ?? body.uri;
        ids.push(body.id);
        ctx.record([...ids]);
      }
      if (!firstUrl && ids.length) {
        // Resumed thread: look up the first status's public link (best effort).
        try {
          const { body } = await api<Status>(base, token, "status", "GET", `/api/v1/statuses/${encodeURIComponent(ids[0])}`);
          firstUrl = body.url ?? body.uri;
        } catch {
          firstUrl = null;
        }
      }
      return { ids, url: firstUrl };
    },

    async metrics(ctx) {
      const base = instanceUrl(ctx.credentials);
      const token = ctx.credentials.accessToken ?? "";
      const out: ItemMetrics[] = new Array(ctx.externalIds.length);
      // A few at a time: threads are short and the rate limit is 300 calls / 5 min.
      for (let i = 0; i < ctx.externalIds.length; i += 4) {
        const chunk = ctx.externalIds.slice(i, i + 4);
        (await Promise.all(chunk.map((id) => statusMetrics(base, token, id)))).forEach((m, j) => (out[i + j] = m));
      }
      return out;
    },
  };
}
