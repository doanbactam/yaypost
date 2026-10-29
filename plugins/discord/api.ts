// Discord via a channel webhook: a thread becomes consecutive messages (webhooks can't reply).
// Checked against https://docs.discord.com/developers/resources/webhook, /reference#uploading-files and
// /topics/rate-limits (2026-10): GET /webhooks/{id}/{token} → webhook (name, channel_id, guild_id, no auth);
// POST same URL ?wait=true → the created message (else 204); content ≤ 2000; multipart payload_json + files[n] with
// attachments [{ id: n, filename, description }] (description = alt text); allowed_mentions { parse: [] } so text can't
// ping @everyone/roles/users; errors { code, message, errors }; 429 { retry_after (s, float), global } + Retry-After,
// X-RateLimit-Remaining / X-RateLimit-Reset-After. A webhook answering 404 must not be used again.
import type { Credentials, PlatformDefinition, PublishItem, YaypostAPI } from "yaypost/plugin";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

/** verify/publish/metrics, bound to this plugin's `ts`. */
export function createDiscord(ts: YaypostAPI): Pick<PlatformDefinition, "verify" | "publish" | "metrics"> {
  interface Webhook {
    name?: string | null;
    channel_id?: string | null;
    guild_id?: string | null;
  }
  interface DiscordError {
    code?: number;
    message?: string;
    errors?: unknown;
    retry_after?: number;
  }

  /** Rate-limit waits up to this long are absorbed (once for a 429); longer ones fail with "retry in …". */
  const MAX_WAIT_S = 10;
  /** Discord caps an attachment description (alt text) at 1024 characters. */
  const ALT_LIMIT = 1024;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function webhookUrl(c: Credentials): URL {
    let url: URL;
    try {
      url = new URL(c.webhookUrl ?? "");
    } catch {
      throw new ts.PlatformError("The webhook URL isn't a URL. Copy it from Server settings → Integrations → Webhooks → Copy webhook URL.", 400, false);
    }
    if (!/\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname)) {
      throw new ts.PlatformError("That isn't a Discord webhook URL (expected …/api/webhooks/<id>/<token>). Copy it from Server settings → Integrations → Webhooks.", 400, false);
    }
    return url;
  }

  /** First field-level message in Discord's nested `errors` object, if any. */
  function firstFieldError(errors: unknown): string | null {
    if (!errors || typeof errors !== "object") return null;
    const e = errors as { _errors?: { message?: string }[] };
    if (Array.isArray(e._errors) && e._errors[0]?.message) return e._errors[0].message;
    for (const v of Object.values(errors)) {
      const m = firstFieldError(v);
      if (m) return m;
    }
    return null;
  }

  function explain(status: number, body: DiscordError | undefined, retryAfter: number | null): PlatformError {
    const field = firstFieldError(body?.errors);
    const detail = [body?.message, field].filter(Boolean).join(": ") || `HTTP ${status}`;
    if (status === 401 || status === 403 || status === 404) {
      // Reported as 401 so the account is flagged: the webhook was deleted, or its URL/token is wrong.
      return new ts.PlatformError(
        `Discord doesn't accept this webhook any more (${status}: ${detail}). It was probably deleted: create a new one (Server settings → Integrations → Webhooks) and update the account's webhook URL.`,
        401,
      );
    }
    if (status === 429) return new ts.PlatformError(`Discord rate limit (${detail}). Retry in ${Math.ceil(retryAfter ?? 60)} s.`, 429);
    if (status === 413) return new ts.PlatformError("Discord refused the upload as too large (413). Use smaller images (the default limit is 10 MB per message), then Retry.", 413);
    if (status >= 500) return new ts.PlatformError(`Discord error ${status} (${detail}). Usually temporary: Retry in a few minutes.`, status);
    return new ts.PlatformError(`Discord rejected the message (${status}: ${detail}).`, status);
  }

  async function request<T>(method: "GET" | "POST", url: URL, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: body === undefined || body instanceof FormData ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(body instanceof FormData ? 90_000 : 30_000),
        });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") {
          throw new ts.PlatformError("Discord didn't answer in time; the message may or may not be posted, so check the channel before you Retry.");
        }
        const cause = (err as { cause?: { code?: string } }).cause;
        throw new ts.PlatformError(`Couldn't reach Discord at ${url.host} (${cause?.code ?? (err as Error).message}). Check the server's internet connection, then Retry.`);
      }
      const raw = await res.text();
      let json: unknown;
      try {
        json = raw ? JSON.parse(raw) : undefined;
      } catch {
        json = undefined;
      }
      if (res.ok) {
        // Bucket exhausted: wait for it to refill before the next message (only if that's short).
        const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
        if (res.headers.get("x-ratelimit-remaining") === "0" && resetAfter > 0 && resetAfter <= MAX_WAIT_S) await sleep(resetAfter * 1000);
        return json as T;
      }
      const err = json as DiscordError | undefined;
      const header = Number(res.headers.get("retry-after"));
      const retryAfter = typeof err?.retry_after === "number" ? err.retry_after : Number.isFinite(header) && header > 0 ? header : null;
      if (res.status === 429 && attempt === 0 && retryAfter !== null && retryAfter <= MAX_WAIT_S) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw explain(res.status, err, retryAfter);
    }
  }

  function messageBody(item: PublishItem): unknown {
    const payload = { content: item.text, allowed_mentions: { parse: [] as string[] } };
    if (!item.mediaIds.length) return payload;
    const form = new FormData();
    const attachments = item.mediaIds.map((id, i) => {
      const m = ts.media.get(id);
      if (!m) throw new ts.PlatformError(`An image of this post (${id}) no longer exists; remove it from the post and Retry.`, 400);
      form.set(`files[${i}]`, new Blob([new Uint8Array(ts.media.read(id))], { type: m.mime }), m.filename);
      return { id: i, filename: m.filename, ...(m.alt ? { description: m.alt.slice(0, ALT_LIMIT) } : {}) };
    });
    form.set("payload_json", JSON.stringify({ ...payload, attachments }));
    return form;
  }

  return {
    async verify(c) {
      const hook = await request<Webhook>("GET", webhookUrl(c));
      if (!hook) throw new ts.PlatformError("Discord answered the webhook check without JSON; check the webhook URL.", 502);
      const channel = hook.channel_id ? ` → channel ${hook.channel_id}` : "";
      return {
        handle: `${hook.name ?? "webhook"}${channel}`,
        profileUrl: hook.guild_id && hook.channel_id ? `https://discord.com/channels/${hook.guild_id}/${hook.channel_id}` : null,
      };
    },

    async publish(ctx) {
      const base = webhookUrl(ctx.credentials);
      const hook = await request<Webhook>("GET", base);
      if (!hook) throw new ts.PlatformError("Discord answered the webhook check without JSON; check the webhook URL.", 502);
      const post = new URL(base);
      post.searchParams.set("wait", "true");
      const ids = [...ctx.posted];
      for (const item of ctx.items.slice(ids.length)) {
        const message = await request<{ id: string; channel_id?: string }>("POST", post, messageBody(item));
        if (!message?.id) throw new ts.PlatformError("Discord accepted the message but returned no id; check the channel before you Retry.");
        ids.push(message.id);
        ctx.record([...ids]);
      }
      const channel = hook.channel_id;
      return { ids, url: ids.length && hook.guild_id && channel ? `https://discord.com/channels/${hook.guild_id}/${channel}/${ids[0]}` : null };
    },
  };
}
