// Example third-party Yaypost plugin, and a template for new platforms. It registers a "webhook" platform: each
// item of a thread is POSTed as JSON to the account's URL, in order, and the receiver's reply (an `id` field, or the
// item number) becomes the item's id. Load it with yaypost.config.json → "plugins": { "load": ["./examples/plugin-webhook"] }
// or copy the folder into <DATA_DIR>/plugins/.
import type { PlatformDefinition, YaypostAPI } from "yaypost/plugin";

export default function webhook(ts: YaypostAPI): void {
  const post = async (url: string, secret: string | undefined, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((err: Error) => {
      throw new ts.PlatformError(`Couldn't reach ${new URL(url).host}: ${err.message}`);
    });
    if (res.status === 401 || res.status === 403) throw new ts.PlatformError(`${new URL(url).host} refused the request (${res.status}); check the secret.`, res.status);
    if (!res.ok) throw new ts.PlatformError(`${new URL(url).host} answered ${res.status}.`, res.status);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  };

  const platform: PlatformDefinition = {
    id: "webhook",
    name: "Webhook",
    maxChars: Number(ts.settings().maxChars ?? 10_000),
    maxImages: 4,
    threadMode: "messages",
    counting: { method: "codepoints" },
    costNote: "Free: posts go to your own endpoint.",
    setup: "Any HTTPS endpoint that accepts POST JSON {postId, index, text, images[]} (n8n, Zapier, Make, your service). Optional bearer secret.",
    credentials: [
      { key: "url", label: "Endpoint URL", secret: false, placeholder: "https://hooks.example.com/yaypost" },
      { key: "secret", label: "Bearer secret", secret: true, optional: true },
    ],
    brand: { color: "#6b7280" },

    async verify(credentials) {
      let url: URL;
      try {
        url = new URL(credentials.url ?? "");
      } catch {
        throw new ts.PlatformError("That isn't a URL.");
      }
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") throw new ts.PlatformError("Use an https:// URL.");
      await post(url.href, credentials.secret, { type: "verify" });
      return { handle: url.host, profileUrl: null };
    },

    async publish(ctx) {
      const ids = [...ctx.posted];
      for (let i = ids.length; i < ctx.items.length; i++) {
        const item = ctx.items[i]!;
        const images = item.mediaIds.map((id) => ({ url: ts.media.publicUrl(id), alt: ts.media.get(id)?.alt ?? null }));
        const reply = await post(ctx.credentials.url!, ctx.credentials.secret, { type: "item", postId: ctx.postId, index: i, text: item.text, images });
        ids.push(typeof reply.id === "string" ? reply.id : `${ctx.postId}:${i}`);
        ctx.record(ids);
      }
      return { ids, url: null };
    },
  };

  ts.registerPlatform(platform);
}
