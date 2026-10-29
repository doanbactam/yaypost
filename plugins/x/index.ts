// X as a Yaypost platform: the person's own OAuth 1.0a keys (connected account, or the legacy .env mode, where
// the core passes { apiKey, apiSecret, accessToken, accessTokenSecret } from .env and a stand-in account).
// Metrics: GET /2/tweets public_metrics via readPostMetrics (api.ts has the doc links). Reads are billed.
import type { Credentials, ItemMetrics, YaypostAPI } from "yaypost/plugin";
import { createXClient, type XPublicMetrics } from "./api.ts";
import type { OAuthCredentials } from "./oauth.ts";

export default function (ts: YaypostAPI) {
  const client = createXClient(ts);

  function oauth(c: Credentials): OAuthCredentials {
    const creds = { consumerKey: c.apiKey ?? "", consumerSecret: c.apiSecret ?? "", token: c.accessToken ?? "", tokenSecret: c.accessTokenSecret ?? "" };
    if (!creds.consumerKey || !creds.consumerSecret || !creds.token || !creds.tokenSecret) {
      throw new ts.PlatformError(
        "X API keys are missing: the API key, API key secret, access token and access token secret are all needed (for the .env mode: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET in .env, then restart).",
        401,
      );
    }
    return creds;
  }

  ts.registerPlatform({
    id: "x",
    name: "X",
    // X's default limit is the server setting (yaypost.config.json maxChars), read each time it is asked for.
    get maxChars() {
      return ts.host().maxChars;
    },
    maxImages: 4,
    threadMode: "replies",
    counting: { method: "x-weighted" },
    costNote: "Paid: X API pay-per-use, about $0.015 per post and $0.20 per post containing a link.",
    setup: 'developer.x.com → your app → Keys and tokens. Set app permissions to "Read and write" before generating the access token.',
    credentials: [
      { key: "apiKey", label: "API key", secret: false },
      { key: "apiSecret", label: "API key secret", secret: true },
      { key: "accessToken", label: "Access token", secret: false },
      { key: "accessTokenSecret", label: "Access token secret", secret: true },
    ],
    metricsNote:
      "X bills every read: about $0.005 per post (each post counted once per UTC day), so a 10-post thread costs about $0.05 per refresh. Only fetch when asked.",
    metricsPaid: true,
    brand: {
      color: "#000000",
      iconPath: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
    },

    verify: async (c) => client.verifyX(oauth(c)),

    publish: async (ctx) =>
      client.publishThreadToX({
        creds: oauth(ctx.credentials),
        items: ctx.items,
        posted: ctx.posted,
        record: ctx.record,
      }),

    async metrics(ctx) {
      const found: Map<string, XPublicMetrics> = await client.readPostMetrics(oauth(ctx.credentials), ctx.externalIds);
      return ctx.externalIds.map((id) => {
        const p = found.get(id);
        const m: ItemMetrics = { id };
        if (!p) return m; // deleted, protected or not a post id
        if (typeof p.like_count === "number") m.likes = p.like_count;
        const reposts = p.retweet_count ?? p.repost_count;
        if (typeof reposts === "number") m.reposts = reposts;
        if (typeof p.reply_count === "number") m.replies = p.reply_count;
        if (typeof p.quote_count === "number") m.quotes = p.quote_count;
        if (typeof p.impression_count === "number") m.views = p.impression_count;
        if (typeof p.bookmark_count === "number") m.bookmarks = p.bookmark_count;
        return m;
      });
    },
  });
}
