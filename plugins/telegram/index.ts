// Telegram as a Yaypost platform (publishing to a channel or group; the approval chat is the telegram-approvals
// plugin). The Bot API client (and the doc references) is in api.ts.
import type { YaypostAPI } from "yaypost/plugin";
import { createTelegram } from "./api.ts";

export default function (ts: YaypostAPI) {
  ts.registerPlatform({
    id: "telegram",
    name: "Telegram",
    maxChars: 4096,
    maxCharsWithMedia: 1024, // a photo caption holds 1024 characters, a text message 4096
    maxImages: 10,
    threadMode: "messages",
    counting: { method: "codepoints" },
    costNote: "Free.",
    setup: "Talk to @BotFather → /newbot → copy the token; add the bot as an admin of your channel or group. Chat id: @channelname or the numeric id.",
    credentials: [
      { key: "botToken", label: "Bot token", secret: true },
      { key: "chatId", label: "Chat id", secret: false, placeholder: "@mychannel or -100…" },
    ],
    brand: { color: "#26A5E4" },
    ...createTelegram(ts),
  });
}
