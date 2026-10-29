// Bluesky as a Yaypost platform. The AT Protocol client (and the lexicon references) is in api.ts.
import type { YaypostAPI } from "yaypost/plugin";
import { createBlueskyClient, MAX_BLOB_BYTES, type StrongRef } from "./api.ts";
import { detectFacets } from "./facets.ts";

export default function (ts: YaypostAPI) {
  const bsky = createBlueskyClient(ts);

  ts.registerPlatform({
    id: "bluesky",
    name: "Bluesky",
    maxChars: 300,
    maxImages: 4,
    maxImageBytes: MAX_BLOB_BYTES,
    threadMode: "replies",
    counting: { method: "graphemes" },
    costNote: "Free.",
    setup: "bsky.app → Settings → Privacy and security → App passwords → Add. Never use your main password.",
    credentials: [
      { key: "identifier", label: "Handle", secret: false, placeholder: "you.bsky.social" },
      { key: "appPassword", label: "App password", secret: true, placeholder: "xxxx-xxxx-xxxx-xxxx" },
      { key: "service", label: "PDS URL", secret: false, optional: true, placeholder: "https://bsky.social", help: "Only for self-hosted PDS." },
    ],
    brand: { color: "#0085FF" },

    async verify(c) {
      const s = await bsky.signIn(c);
      return { handle: `@${s.handle}`, profileUrl: bsky.profileUrl(s) };
    },

    async publish(ctx) {
      const refs: StrongRef[] = ctx.posted.map(bsky.decodeRef);
      const todo = ctx.items.slice(refs.length);
      // Size problems found before anything is posted, so they can't leave half a thread.
      for (const [i, item] of todo.entries()) {
        for (const id of item.mediaIds) {
          const m = bsky.mediaOrFail(id);
          if (m.size > MAX_BLOB_BYTES) {
            throw new ts.PlatformError(
              `${m.filename} in post ${refs.length + i + 1} is ${(m.size / 1_000_000).toFixed(1)} MB; Bluesky accepts images up to ${MAX_BLOB_BYTES / 1_000_000} MB. Use a smaller or more compressed image (or give Bluesky its own version without it), then Retry.`,
              413,
            );
          }
        }
      }
      const s = await bsky.signIn(ctx.credentials);
      const resolve = async (handle: string) => {
        try {
          return (await bsky.xrpc<{ did: string }>(s.base, "com.atproto.identity.resolveHandle", { jwt: s.jwt, query: { handle } })).did ?? null;
        } catch {
          return null;
        }
      };
      const ids = [...ctx.posted];
      for (const item of todo) {
        const images = [];
        for (const id of item.mediaIds) images.push(await bsky.uploadImage(s, id));
        const facets = await detectFacets(item.text, resolve);
        const record = {
          $type: "app.bsky.feed.post",
          text: item.text,
          createdAt: new Date().toISOString(),
          ...(facets.length ? { facets } : {}),
          ...(images.length ? { embed: { $type: "app.bsky.embed.images", images } } : {}),
          ...(refs.length ? { reply: { root: refs[0], parent: refs[refs.length - 1] } } : {}),
        };
        const { uri, cid } = await bsky.xrpc<StrongRef>(s.base, "com.atproto.repo.createRecord", {
          jwt: s.jwt,
          json: { repo: s.did, collection: "app.bsky.feed.post", record },
        });
        refs.push({ uri, cid });
        ids.push(bsky.encodeRef({ uri, cid }));
        ctx.record([...ids]);
      }
      return { ids, url: refs.length ? bsky.postUrl(s, refs[0]!) : null };
    },

    metrics: (ctx) => bsky.postMetrics(ctx.externalIds),
  });
}
