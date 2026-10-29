// Discord as a Yaypost platform (publishing through a channel webhook; the approval chat is the
// discord-approvals plugin). The webhook client (and the doc references) is in api.ts.
import type { YaypostAPI } from "yaypost/plugin";
import { createDiscord } from "./api.ts";

export default function (ts: YaypostAPI) {
  ts.registerPlatform({
    id: "discord",
    name: "Discord",
    maxChars: 2000,
    maxImages: 10,
    threadMode: "messages",
    counting: { method: "codepoints" },
    costNote: "Free.",
    setup: "Server settings → Integrations → Webhooks → New webhook → choose the channel → Copy webhook URL.",
    credentials: [{ key: "webhookUrl", label: "Webhook URL", secret: true, placeholder: "https://discord.com/api/webhooks/…" }],
    brand: { color: "#5865F2" },
    ...createDiscord(ts),
  });
}
