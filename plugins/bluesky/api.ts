// Bluesky over AT Protocol XRPC, signed in with an app password (a fresh session per verify/publish).
// Checked 2026-10-29 against the canonical lexicons (docs.bsky.app now redirects to a JS-only reference):
// com.atproto.server.createSession {identifier, password} → {accessJwt, did, handle}; errors AuthFactorTokenRequired,
// AccountTakedown (github.com/bluesky-social/atproto lexicons/com/atproto); com.atproto.repo.uploadBlob (raw bytes) →
// {blob}; com.atproto.repo.createRecord {repo, collection, record} → {uri, cid}; app.bsky.feed.post reply {root, parent}
// strong refs; app.bsky.richtext.facet byteSlice = UTF-8 byte offsets, features #link/#tag/#mention;
// app.bsky.embed.images ≤4 images, image blob maxSize 2,000,000 bytes ("formerly limited to 1 MB"), alt required,
// aspectRatio {width, height} (github.com/bluesky-social/bsky lexicons/app/bsky). XRPC errors are {error, message}.
// Item ids are stored as "<at-uri>|<cid>" so a retry can rebuild the reply refs from ctx.posted alone.
// Metrics: app.bsky.feed.getPosts {uris: ≤25 at-uris} → {posts: postView[]}, postView has optional likeCount,
// repostCount, replyCount, quoteCount, bookmarkCount; posts the AppView can't see are simply left out (lexicons
// app/bsky/feed/getPosts.json and defs.json in github.com/bluesky-social/bsky, checked 2026-10-29). Read
// unauthenticated from the public AppView (https://public.api.bsky.app, override with BLUESKY_APPVIEW_BASE), never the
// account's `service`: a PDS (bsky.social or self-hosted) only proxies app.bsky.* reads for signed-in users, and posts
// from self-hosted PDSes reach the Bluesky AppView through the relay anyway. So no session and no app password needed.
import type { Credentials, ItemMetrics, YaypostAPI } from "yaypost/plugin";
import { imageSize } from "./image-size.ts";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

export const MAX_BLOB_BYTES = 2_000_000;
const DEFAULT_SERVICE = "https://bsky.social";
const APP_PASSWORDS = "bsky.app → Settings → Privacy and security → App passwords";

export interface StrongRef {
  uri: string;
  cid: string;
}
interface Session {
  base: string;
  jwt: string;
  did: string;
  handle: string;
}

interface PostView {
  uri: string;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
  bookmarkCount?: number;
}

export function createBlueskyClient(ts: YaypostAPI) {
  const serviceUrl = (c: Credentials) => {
    const s = (c.service?.trim() || DEFAULT_SERVICE).replace(/\/+$/, "");
    return /^https?:\/\//i.test(s) ? s : `https://${s}`;
  };

  function untilText(h: Headers): string {
    const reset = Number(h.get("ratelimit-reset"));
    if (!reset) return "in a few minutes";
    const minutes = Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000));
    return `after ${new Date(reset * 1000).toISOString().replace(/\.\d+Z$/, "Z")} (in ~${minutes} min)`;
  }

  function explain(nsid: string, status: number, headers: Headers, error: string, message: string): PlatformError {
    const detail = [error, message].filter(Boolean).join(": ") || `HTTP ${status}`;
    if (error === "AuthFactorTokenRequired") {
      return new ts.PlatformError(`Bluesky asked for an email sign-in code (${detail}). Use an app password (${APP_PASSWORDS}), not your main password; app passwords skip that step.`, 401);
    }
    if (error === "AccountTakedown" || error === "AccountDeactivated") {
      return new ts.PlatformError(`Bluesky says this account can't post (${detail}). Check it on bsky.app; Retry won't help until it is active again.`, 403, false);
    }
    if (nsid === "com.atproto.server.createSession" && (status === 401 || error === "AuthenticationRequired")) {
      return new ts.PlatformError(`Bluesky rejected the handle or app password (${status}: ${detail}). Create a new app password at ${APP_PASSWORDS}, update the account's credentials, then Retry.`, 401);
    }
    if (status === 401 || error === "ExpiredToken" || error === "InvalidToken") {
      return new ts.PlatformError(`Bluesky ended the session (${status}: ${detail}). Retry signs in again; if it keeps failing, re-check the app password.`, 401);
    }
    if (status === 429) return new ts.PlatformError(`Bluesky rate limit reached (429: ${detail}). Retry ${untilText(headers)}.`, 429);
    if (status === 413 || error === "BlobTooLarge" || error === "PayloadTooLarge") {
      return new ts.PlatformError(`Bluesky refused an image as too large (${status}: ${detail}). Use a smaller image (under ${MAX_BLOB_BYTES / 1_000_000} MB, or 1 MB on older PDSes), then Retry.`, 413);
    }
    if (status >= 500) return new ts.PlatformError(`Bluesky error ${status} (${detail}). Usually temporary: Retry in a few minutes.`, status);
    if (status === 400) return new ts.PlatformError(`Bluesky rejected the request (400: ${detail}). Fix the content (too long, bad image?) and Retry.`, 400);
    return new ts.PlatformError(`Bluesky error ${status}: ${detail}`, status);
  }

  async function xrpc<T>(
    base: string,
    nsid: string,
    opts: { jwt?: string; json?: unknown; bytes?: Uint8Array; mime?: string; query?: Record<string, string> } = {},
  ): Promise<T> {
    const post = opts.json !== undefined || opts.bytes !== undefined;
    const url = `${base}/xrpc/${nsid}${opts.query ? "?" + new URLSearchParams(opts.query) : ""}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: post ? "POST" : "GET",
        headers: {
          ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}),
          ...(opts.json !== undefined ? { "content-type": "application/json" } : opts.bytes ? { "content-type": opts.mime ?? "application/octet-stream" } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.bytes && new Uint8Array(opts.bytes),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new ts.PlatformError(`Bluesky didn't answer ${nsid} within 60s; it may or may not have gone through, so check your profile before you Retry.`);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ts.PlatformError(`Couldn't reach Bluesky at ${base} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the PDS URL and the server's internet connection, then Retry.`);
    }
    const raw = await res.text();
    let body: { error?: string; message?: string } | undefined;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    if (!res.ok) throw explain(nsid, res.status, res.headers, body?.error ?? "", body?.message ?? raw.trim().slice(0, 200));
    if (!body) throw new ts.PlatformError(`Bluesky answered ${nsid} with ${res.status} but no JSON: ${raw.slice(0, 200)}`, res.status);
    return body as T;
  }

  async function signIn(c: Credentials): Promise<Session> {
    if (!c.identifier || !c.appPassword) throw new ts.PlatformError(`Bluesky needs the handle and an app password (${APP_PASSWORDS}).`, 401);
    const base = serviceUrl(c);
    const s = await xrpc<{ accessJwt: string; did: string; handle: string; active?: boolean; status?: string }>(base, "com.atproto.server.createSession", {
      json: { identifier: c.identifier.replace(/^@/, ""), password: c.appPassword },
    });
    if (s.active === false) {
      throw new ts.PlatformError(`Bluesky says this account is ${s.status ?? "inactive"}. Check it on bsky.app; Retry won't help until it is active again.`, 403, false);
    }
    return { base, jwt: s.accessJwt, did: s.did, handle: s.handle };
  }

  const profileUrl = (s: Session) => `https://bsky.app/profile/${s.handle && s.handle !== "handle.invalid" ? s.handle : s.did}`;
  const postUrl = (s: Session, ref: StrongRef) => `${profileUrl(s)}/post/${ref.uri.split("/").pop()}`;

  const encodeRef = (r: StrongRef) => `${r.uri}|${r.cid}`;
  function decodeRef(id: string): StrongRef {
    const [uri, cid] = id.split("|");
    if (!uri?.startsWith("at://") || !cid) {
      throw new ts.PlatformError(`Can't continue this Bluesky thread: the saved id "${id}" isn't a post reference. Duplicate the post into a new draft to post it again.`, undefined, false);
    }
    return { uri, cid };
  }

  function mediaOrFail(id: string) {
    const m = ts.media.get(id);
    if (!m) throw new ts.PlatformError(`Image ${id} no longer exists; remove it from the post and Retry.`);
    return m;
  }

  async function uploadImage(s: Session, mediaId: string) {
    const m = mediaOrFail(mediaId);
    const data = ts.media.read(mediaId);
    const { blob } = await xrpc<{ blob: unknown }>(s.base, "com.atproto.repo.uploadBlob", { jwt: s.jwt, bytes: data, mime: m.mime });
    const size = imageSize(data);
    return { image: blob, alt: m.alt?.trim() ?? "", ...(size && size.width > 0 && size.height > 0 ? { aspectRatio: size } : {}) };
  }

  // metrics

  const appViewUrl = () => (ts.env("BLUESKY_APPVIEW_BASE") || "https://public.api.bsky.app").replace(/\/+$/, "");
  const GET_POSTS_MAX = 25;

  async function postMetrics(externalIds: string[]): Promise<ItemMetrics[]> {
    const uris = externalIds.map((id) => id.split("|")[0] ?? id);
    const found = new Map<string, PostView>();
    const valid = [...new Set(uris.filter((u) => u.startsWith("at://")))];
    for (let i = 0; i < valid.length; i += GET_POSTS_MAX) {
      const query = new URLSearchParams();
      for (const u of valid.slice(i, i + GET_POSTS_MAX)) query.append("uris", u);
      const url = `${appViewUrl()}/xrpc/app.bsky.feed.getPosts?${query}`;
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") throw new ts.PlatformError(`The Bluesky AppView (${appViewUrl()}) didn't answer within 30s. Try again in a minute.`);
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        throw new ts.PlatformError(`Couldn't reach the Bluesky AppView at ${appViewUrl()} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the server's internet connection (or BLUESKY_APPVIEW_BASE).`);
      }
      const raw = await res.text();
      let body: { posts?: PostView[]; error?: string; message?: string } | undefined;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (!res.ok) {
        const error = body?.error ?? "", message = body?.message ?? raw.trim().slice(0, 200);
        if (res.status === 429 || res.status >= 500) throw explain("app.bsky.feed.getPosts", res.status, res.headers, error, message);
        throw new ts.PlatformError(`The Bluesky AppView refused getPosts (${res.status}: ${[error, message].filter(Boolean).join(": ") || "no detail"}). If BLUESKY_APPVIEW_BASE is set, check it points at an AppView (default https://public.api.bsky.app).`, res.status);
      }
      if (!Array.isArray(body?.posts)) throw new ts.PlatformError(`The Bluesky AppView answered getPosts with ${res.status} but no posts list: ${raw.slice(0, 200)}`, res.status);
      for (const p of body.posts) found.set(p.uri, p);
    }
    return uris.map((uri) => {
      const p = found.get(uri);
      if (!p) return { id: uri }; // deleted, taken down or not indexed yet
      const m: ItemMetrics = { id: uri };
      if (typeof p.likeCount === "number") m.likes = p.likeCount;
      if (typeof p.repostCount === "number") m.reposts = p.repostCount;
      if (typeof p.replyCount === "number") m.replies = p.replyCount;
      if (typeof p.quoteCount === "number") m.quotes = p.quoteCount;
      if (typeof p.bookmarkCount === "number") m.bookmarks = p.bookmarkCount;
      return m;
    });
  }

  return { signIn, profileUrl, postUrl, decodeRef, encodeRef, mediaOrFail, uploadImage, xrpc, postMetrics };
}
