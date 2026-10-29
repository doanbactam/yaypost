// LinkedIn as a Yaypost platform. The Posts/Images API client (and the doc references) is in api.ts.
import type { YaypostAPI } from "yaypost/plugin";
import { createLinkedIn } from "./api.ts";

export default function (ts: YaypostAPI) {
  ts.registerPlatform({
    id: "linkedin",
    name: "LinkedIn",
    maxChars: 3000,
    maxImages: 20,
    imageTypes: ["image/jpeg", "image/png", "image/gif"],
    threadMode: "single",
    counting: { method: "codepoints" },
    costNote: "Free. Needs an app with the w_member_social scope (Share on LinkedIn product). Threads are joined into one post.",
    setup: "linkedin.com/developers → create an app → add “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect” → generate an access token with openid, profile, w_member_social (valid 60 days).",
    credentials: [{ key: "accessToken", label: "Access token", secret: true }],
    brand: { color: "#0A66C2" },
    ...createLinkedIn(ts),
  });
}
