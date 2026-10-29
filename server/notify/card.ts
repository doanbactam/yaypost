// The texts the approval chats get: approval cards, alerts, the daily digest. Plain text, cut to each channel's limit.
import type { Post } from "../../shared/types.ts";
import { listAccounts } from "../accounts.ts";
import { previewPost } from "../api.ts";
import { formatLocal, localDateKey } from "../config.ts";
import { pauseState } from "../control.ts";
import { publicUrl } from "../env.ts";
import { refreshMetrics } from "../metrics.ts";
import { platformName } from "../plugins.ts";
import { listAwaiting, listPosts } from "../repo.ts";

export const postLink = (id: string) => `${publicUrl()}/?post=${id}`;

const firstLine = (text: string | undefined, n = 70) => {
  const line = (text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "(empty)";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

export const postName = (p: Post) => `“${p.title?.trim() || firstLine(p.thread[0]?.text)}”`;

const requester = (p: Post) => {
  const by = p.approval?.by ?? `agent:${p.source}`;
  return by.replace(/^agent:/, "") === "operator" ? "The operator" : `An agent (${by.replace(/^agent:/, "")})`;
};

/** Cut to `max` characters, ending on a marker so it's clear something was left out. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 2).trimEnd() + "\n…";
}

/**
 * The approval request: who asks, when it would go out, and exactly what each destination receives (counted the way
 * that platform counts), with anything that would stop it. The link opens it in Yaypost for edits.
 */
export function approvalCard(post: Post, max: number): string {
  const when = post.scheduledAt && Date.parse(post.scheduledAt) > Date.now() + 60_000 ? formatLocal(post.scheduledAt) : "as soon as you approve";
  const head = [`🟡 ${requester(post)} wants to publish ${postName(post)}`, `When: ${when}`];
  if (post.title?.trim()) head.push(`Title: ${post.title.trim()}`);
  const link = `Open / edit: ${postLink(post.id)}`;
  const blocks = previewPost(post).targets.map((t) => {
    const n = t.items.length;
    const lines = [`→ ${t.label}${t.label.toLowerCase().includes(platformName(t.platform).toLowerCase()) ? "" : ` (${platformName(t.platform)})`}${n > 1 ? ` · ${n} posts` : ""}`];
    t.items.forEach((it, i) => {
      const done = i < t.live ? " (already live)" : "";
      lines.push(`${n > 1 ? `[${i + 1}] ` : ""}${it.text.trim() || "(no text)"}${it.images ? ` [+${it.images} image${it.images > 1 ? "s" : ""}]` : ""}`);
      lines.push(`   ${it.count}/${t.limit}${it.fits ? "" : " ⚠ doesn't fit"}${done}`);
    });
    if (t.problem) lines.push(`⚠ ${t.problem}`);
    return lines.join("\n");
  });
  const fixed = head.join("\n").length + link.length + 8;
  return [head.join("\n"), clip(blocks.join("\n\n"), Math.max(200, max - fixed)), link].join("\n\n");
}

/** One line about how a request ended, shown in place of its buttons. */
export function outcomeLine(post: Post | null, event: string): string {
  const by = (s?: string | null) => (s ? ` by ${s.replace(/^owner:/, "")}` : "");
  switch (event) {
    case "post.approved":
      return `✅ Approved${by(post?.approval?.by)}${post?.scheduledAt && Date.parse(post.scheduledAt) > Date.now() + 60_000 ? ` · goes out ${formatLocal(post.scheduledAt)}` : " · going out now"}`;
    case "post.rejected":
      return `❌ Rejected${by(post?.approval?.by)}${post?.approval?.note ? `: ${post.approval.note}` : ""}`;
    case "post.changes_requested":
      return `✏️ Changes requested${by(post?.approval?.by)}: ${post?.approval?.note ?? ""}\nWaiting for the agent's new version.`;
    case "post.deleted":
      return "🗑 Deleted before a decision.";
    case "superseded":
      return "↻ Replaced by a newer version (see below).";
    default:
      return "↩ Withdrawn: it was taken off the queue.";
  }
}

/** Waiting items, for /pending and the digest. */
export function pendingText(): string {
  const waiting = listAwaiting();
  if (!waiting.length) return "Nothing is waiting for you.";
  return waiting
    .map((p) =>
      p.approval?.state === "pending"
        ? `🟡 ${postName(p)} — ${p.scheduledAt ? formatLocal(p.scheduledAt) : "now"}\n   ${postLink(p.id)}`
        : `✏️ ${postName(p)} — you asked: ${p.approval?.note ?? ""} (waiting for the agent)`,
    )
    .join("\n");
}

const DAY = 86_400_000;

/**
 * What happened and what's next, in one message. Refreshes engagement numbers first where reading them is free
 * (never the billed X API).
 */
export async function digestText(): Promise<string> {
  const since = new Date(Date.now() - DAY).toISOString();
  const published = listPosts({ status: ["published"], limit: 200 }).filter((p) => (p.publishedAt ?? "") >= since);
  for (const p of published) await refreshMetrics(p.id).catch(() => undefined);
  const lines = [`☀️ Yaypost · ${localDateKey()}`];
  const paused = pauseState();
  if (paused) lines.push(`⏸ Publishing is PAUSED (by ${paused.by.replace(/^owner:/, "")}${paused.reason ? `: ${paused.reason}` : ""}). /resume to restart.`);
  const waiting = listAwaiting();
  if (waiting.length) lines.push("", `Waiting (${waiting.length}):`, pendingText());
  const soon = listPosts({ status: ["scheduled"], from: new Date().toISOString(), to: new Date(Date.now() + DAY).toISOString() }).filter(
    (p) => !p.approval || p.approval.state === "approved",
  );
  lines.push("", soon.length ? `📅 Next 24 h: ${soon.length} going out, first ${formatLocal(soon[0]!.scheduledAt!)}` : "📅 Nothing approved for the next 24 h.");
  if (published.length) {
    lines.push("", `✅ Published in the last 24 h: ${published.length}`);
    for (const p of published.slice(0, 8)) {
      const totals: Record<string, number> = {};
      for (const t of p.targets) for (const [k, v] of Object.entries(t.metrics?.totals ?? {})) totals[k] = (totals[k] ?? 0) + (v ?? 0);
      const nums = Object.entries(totals).map(([k, v]) => `${v} ${k}`).join(", ");
      lines.push(`· ${postName(p)}${nums ? ` — ${nums}` : ""}`);
    }
  }
  const failed = listPosts({ status: ["failed", "due"], limit: 20 });
  if (failed.length) {
    lines.push("", `❗ Needs a look (${failed.length}):`);
    for (const p of failed.slice(0, 5)) lines.push(`· ${postName(p)}: ${firstLine(p.error ?? p.status, 140)}\n  ${postLink(p.id)}`);
  }
  const broken = listAccounts().filter((a) => a.lastError);
  if (broken.length) lines.push("", ...broken.map((a) => `⚠ ${a.label}: ${firstLine(a.lastError ?? "", 160)}`));
  return lines.join("\n");
}
