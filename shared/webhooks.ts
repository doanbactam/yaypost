// Which body a webhook URL gets: Slack and Discord incoming webhooks only take a chat message; anything else gets
// Yaypost's signed JSON envelope. Shared so the app can show the format while you type the URL.

export type WebhookFormat = "json" | "slack" | "discord";
export const WEBHOOK_FORMATS: WebhookFormat[] = ["json", "slack", "discord"];

/** Throws on a string that isn't a URL. */
export function webhookFormatFor(url: string): WebhookFormat {
  const u = new URL(url);
  if (u.hostname === "hooks.slack.com") return "slack";
  if (/(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith("/api/webhooks/")) return "discord";
  return "json";
}
