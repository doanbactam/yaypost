// LinkedIn member posts. Checked 2026-10 against learn.microsoft.com/linkedin: sign-in-with-linkedin-v2 (GET /v2/userinfo
// → sub), marketing/community-management/shares/posts-api, images-api, multiimage-post-api, vector-asset-api (upload)
// and little-text-format. Every /rest call sends LinkedIn-Version (YYYYMM) and X-Restli-Protocol-Version 2.0.0.
// Images: POST /rest/images?action=initializeUpload → PUT the bytes (with the bearer token) to value.uploadUrl;
// JPG/PNG/GIF only. One image → content.media, 2–20 → content.multiImage. The new post's URN is in x-restli-id.
// LinkedIn has no threads (threadMode "single"): the publisher joins the thread into one item.
import type { Credentials, PlatformDefinition, YaypostAPI } from "yaypost/plugin";
import { toCommentary } from "./commentary.ts";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

/** verify/publish/metrics, bound to this plugin's `ts`. */
export function createLinkedIn(ts: YaypostAPI): Pick<PlatformDefinition, "verify" | "publish" | "metrics"> {
  const apiBase = () => (ts.env("LINKEDIN_API_BASE") ?? "https://api.linkedin.com").replace(/\/+$/, "");
  const version = () => ts.env("LINKEDIN_VERSION") ?? "202610";
  const TIMEOUT_MS = 60_000;
  const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif"]);
  const TOKEN_FIX =
    "Generate a new access token with the openid, profile and w_member_social scopes (linkedin.com/developers → your app → Auth → OAuth 2.0 tools; tokens last 60 days) and paste it into this account's credentials, then Retry.";

  interface LinkedInError {
    message?: string;
    code?: string;
    serviceErrorCode?: number;
    status?: number;
  }

  function explain(status: number, e: LinkedInError | undefined, raw: string, headers: Headers): PlatformError {
    const detail = [e?.code, e?.message].filter(Boolean).join(": ") || raw.trim().slice(0, 200) || `HTTP ${status}`;
    if (status === 401) return new ts.PlatformError(`LinkedIn rejected the access token (401 ${detail}); it has expired or was revoked. ${TOKEN_FIX}`, 401);
    if (status === 403) {
      return new ts.PlatformError(
        `LinkedIn refused (403 ${detail}). The token needs the w_member_social scope ("Share on LinkedIn" product) and openid + profile ("Sign In with LinkedIn using OpenID Connect"). ${TOKEN_FIX}`,
        403,
      );
    }
    if (status === 429) {
      const after = Number(headers.get("retry-after"));
      return new ts.PlatformError(`LinkedIn rate limit reached (429 ${detail}). Retry ${after ? `in ~${Math.ceil(after / 60)} min` : "later today; member posting limits reset daily"}.`, 429);
    }
    if (/duplicate/i.test(detail)) {
      return new ts.PlatformError(`LinkedIn refused a duplicate post (${status} ${detail}). It is probably already live: check your feed, and mark this post published if so; otherwise change the text and Retry.`, status, false);
    }
    if (status >= 500) return new ts.PlatformError(`LinkedIn API error ${status} (${detail}). Usually temporary: Retry in a few minutes.`, status);
    return new ts.PlatformError(`LinkedIn rejected the request (${status} ${detail}).`, status);
  }

  async function request(url: string, init: RequestInit, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if ((err as Error).name === "TimeoutError") {
        throw new ts.PlatformError(`LinkedIn didn't answer (${what}) within ${TIMEOUT_MS / 1000}s; it may have gone through, so check your feed before you Retry.`);
      }
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ts.PlatformError(`Couldn't reach LinkedIn at ${new URL(url).origin} (${cause?.code ?? cause?.message ?? (err as Error).message}). Check the server's internet connection, then Retry.`);
    }
    if (!res.ok) {
      const raw = await res.text();
      let e: LinkedInError | undefined;
      try {
        e = JSON.parse(raw);
      } catch {
        e = undefined;
      }
      throw explain(res.status, e, raw, res.headers);
    }
    return res;
  }

  const token = (c: Credentials) => {
    if (!c.accessToken) throw new ts.PlatformError(`No LinkedIn access token is stored. ${TOKEN_FIX}`, 401, false);
    return c.accessToken;
  };

  function headers(tok: string, json = true): Record<string, string> {
    return {
      authorization: `Bearer ${tok}`,
      "linkedin-version": version(),
      "x-restli-protocol-version": "2.0.0",
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async function me(tok: string): Promise<{ sub: string; name?: string }> {
    const res = await request(`${apiBase()}/v2/userinfo`, { headers: { authorization: `Bearer ${tok}` } }, "userinfo");
    const body = (await res.json()) as { sub?: string; name?: string };
    if (!body.sub) throw new ts.PlatformError("LinkedIn's userinfo answer has no member id; the token needs the openid and profile scopes. " + TOKEN_FIX, 403, false);
    return { sub: body.sub, name: body.name };
  }

  async function uploadImage(id: string, owner: string, tok: string): Promise<string> {
    const init = await request(
      `${apiBase()}/rest/images?action=initializeUpload`,
      { method: "POST", headers: headers(tok), body: JSON.stringify({ initializeUploadRequest: { owner } }) },
      "image upload start",
    );
    const { value } = (await init.json()) as { value?: { uploadUrl?: string; image?: string } };
    if (!value?.uploadUrl || !value.image) throw new ts.PlatformError("LinkedIn's initializeUpload answer has no uploadUrl/image; Retry.");
    const buf = ts.media.read(id);
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await request(value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": ts.media.get(id)?.mime ?? "application/octet-stream" }, body: bytes }, "image upload");
    return value.image;
  }

  return {
    async verify(c) {
      const who = await me(token(c));
      return { handle: who.name || who.sub, profileUrl: null };
    },

    async publish(ctx) {
      const posted = ctx.posted[0];
      if (posted) return { ids: [posted], url: `https://www.linkedin.com/feed/update/${posted}` };
      const tok = token(ctx.credentials);
      const item = { text: ctx.items.map((i) => i.text.trim()).filter(Boolean).join("\n\n"), mediaIds: ctx.items.flatMap((i) => i.mediaIds) };
      const media = item.mediaIds.map((id) => ts.media.get(id));
      for (const m of media) {
        if (!m) throw new ts.PlatformError("An image of this post was deleted; remove it from the post, then Retry.", 400);
        if (!IMAGE_MIMES.has(m.mime)) throw new ts.PlatformError(`LinkedIn accepts only JPG, PNG and GIF images; "${m.filename}" is ${m.mime}. Convert or replace it, then Retry.`, 400);
      }
      if (media.length > 20) throw new ts.PlatformError(`LinkedIn allows at most 20 images per post; this one has ${media.length}.`, 400);

      const author = `urn:li:person:${(await me(tok)).sub}`;
      const images: { id: string; altText?: string }[] = [];
      for (const m of media) {
        const urn = await uploadImage(m!.id, author, tok);
        images.push(m!.alt ? { id: urn, altText: m!.alt.slice(0, 4086) } : { id: urn });
      }
      const body: Record<string, unknown> = {
        author,
        commentary: toCommentary(item.text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
      if (images.length === 1) body.content = { media: images[0] };
      else if (images.length > 1) body.content = { multiImage: { images } };

      const res = await request(`${apiBase()}/rest/posts`, { method: "POST", headers: headers(tok), body: JSON.stringify(body) }, "create post");
      const urn = res.headers.get("x-restli-id");
      if (!urn) throw new ts.PlatformError(`LinkedIn answered ${res.status} without the post id (x-restli-id); check your feed before you Retry.`, res.status, false);
      ctx.record([urn]);
      return { ids: [urn], url: `https://www.linkedin.com/feed/update/${urn}` };
    },
  };
}
