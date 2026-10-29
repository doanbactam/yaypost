// Threads (Meta) as a Yaypost platform. The Graph API client (and the doc references) is in api.ts.
import type { YaypostAPI } from "yaypost/plugin";
import { createThreads } from "./api.ts";

export default function (ts: YaypostAPI) {
  ts.registerPlatform({
    id: "threads",
    name: "Threads",
    maxChars: 500,
    maxImages: 20,
    imageTypes: ["image/jpeg", "image/png"],
    threadMode: "replies",
    counting: { method: "codepoints", emoji: "utf8-bytes" }, // an emoji counts as its UTF-8 byte length
    costNote:
      "Free, but needs a Meta developer app with threads_basic, threads_content_publish and threads_manage_replies (for threads). Images must be reachable at PUBLIC_URL over HTTPS.",
    setup: "developers.facebook.com → create an app with the Threads use case → generate a long-lived user access token with threads_basic, threads_content_publish and threads_manage_replies (valid 60 days; refresh it before it expires).",
    credentials: [{ key: "accessToken", label: "Long-lived access token", secret: true }],
    metricsNote: "Needs the threads_manage_insights permission on the Meta app and access token (in addition to threads_basic).",
    brand: { color: "#000000" },
    ...createThreads(ts),
  });
}
