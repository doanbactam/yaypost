// Who did something, in words: audit actors ("agent:operator", "owner:telegram:@alice") and who asked for approval.
import type { Post } from "../../../shared/types.ts";

const AGENTS: Record<string, string> = {
  operator: "The operator",
  mcp: "An agent (MCP)",
  cli: "An agent (CLI)",
  api: "An agent (API)",
};

/** "You", "You on Telegram (@alice)", "The operator", "An agent (MCP)", "The scheduler". */
export function actorName(actor: string): string {
  const [kind, via = "", ...rest] = actor.split(":");
  const handle = rest.join(":");
  if (kind === "owner") {
    if (via === "ui" || !via) return "You";
    const where = via.charAt(0).toUpperCase() + via.slice(1);
    return handle ? `You on ${where} (${handle})` : via === "api" || via === "cli" ? "You" : `You on ${where}`;
  }
  if (kind === "agent") return AGENTS[via] ?? `An agent (${via})`;
  if (kind === "system") return via === "scheduler" ? "The scheduler" : "Yaypost";
  return actor;
}

/** Who asked for approval (approval.by while pending), falling back to the post's source. */
export function askerLabel(post: Post): string {
  const by = post.approval?.by ?? post.source;
  if (by.includes(":")) return actorName(by);
  if (by === "ui") return "You";
  return AGENTS[by] ?? "An agent";
}

/** Who decided ("owner:ui", "owner:telegram:@alice", or without the "owner:" prefix): "you", "you on Telegram (@alice)". */
export function deciderLabel(by: string | null): string {
  if (!by || by === "ui") return "you";
  const name = actorName(/^(owner|agent|system):/.test(by) ? by : `owner:${by}`);
  return name.replace(/^You/, "you").replace(/^The /, "the ").replace(/^An /, "an ");
}
