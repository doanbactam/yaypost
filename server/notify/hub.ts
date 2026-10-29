// Routes what the person must see to their approval chats, and their decisions back into Yaypost.
// Interrupts only for decisions and trouble (approval requests, failures, posts that need them, pauses, broken
// accounts); everything else waits for the daily digest.
import type { AppEvent, ChannelStatus, Post } from "../../shared/types.ts";
import { runAs } from "../actor.ts";
import { getConfig, localDateKey } from "../config.ts";
import { pausePublishing, pauseState, resumePublishing } from "../control.ts";
import { db, kv } from "../db.ts";
import { bus } from "../events.ts";
import { requestRun } from "../operator.ts";
import { decide, getPost, listAwaiting } from "../repo.ts";
import { approvalCard, clip, digestText, outcomeLine, pendingText, postLink, postName } from "./card.ts";
import type { ChannelButton as Button, ChannelCommand as Command, ChannelHandlers } from "../plugin-api.ts";
import { listChannels, onChannelsChange } from "../plugins.ts";

// Channels come from plugins (plugins/telegram-approvals, plugins/discord-approvals, or any other).
const active = () => listChannels().filter((c) => c.configured());
const channelById = (id: string) => listChannels().find((c) => c.id === id);

export const channelStatuses = (): ChannelStatus[] =>
  listChannels().map((c) => ({ ...c.status(), id: c.id, name: c.name, configured: c.configured() }));

async function broadcast(text: string, buttons?: Button[]): Promise<void> {
  await Promise.all(active().map((c) => c.send({ text: clip(text, c.maxLength), buttons })));
}

// ---------- approval messages ----------

const openRefs = (postId: string) =>
  db.prepare("SELECT channel, ref, text FROM approval_messages WHERE post_id = ?").all(postId) as { channel: string; ref: string; text: string }[];

/** Close every open request message of a post: same card, buttons gone, how it ended underneath. */
async function finalizeAll(postId: string, outcome: string): Promise<void> {
  const refs = openRefs(postId);
  if (!refs.length) return;
  db.prepare("DELETE FROM approval_messages WHERE post_id = ?").run(postId);
  await Promise.all(
    refs.map(({ channel, ref, text }) => {
      const c = channelById(channel);
      return c?.finalize(ref, `${clip(text, c.maxLength - outcome.length - 2)}\n\n${outcome}`);
    }),
  );
}

async function requestApproval(post: Post): Promise<void> {
  await finalizeAll(post.id, outcomeLine(post, "superseded"));
  const buttons: Button[] = [
    { label: "✅ Approve", action: "approve", postId: post.id },
    { label: "✏️ Request changes", action: "changes", postId: post.id },
    { label: "❌ Reject", action: "reject", postId: post.id },
  ];
  await Promise.all(
    active().map(async (c) => {
      const text = approvalCard(post, c.maxLength);
      const ref = await c.send({ text, buttons });
      if (ref) {
        db.prepare("INSERT OR REPLACE INTO approval_messages (post_id, channel, ref, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
          post.id,
          c.id,
          ref,
          text,
          new Date().toISOString(),
        );
      }
    }),
  );
}

async function onEvent(e: AppEvent): Promise<void> {
  switch (e.type) {
    case "post.approval_requested":
      return requestApproval(e.post);
    case "post.approved":
    case "post.rejected":
    case "post.changes_requested":
      return finalizeAll(e.post.id, outcomeLine(e.post, e.type));
    case "post.deleted":
      return finalizeAll(e.id, outcomeLine(null, e.type));
    case "post.updated":
    case "post.scheduled":
      if (e.post.approval?.state !== "pending" && e.post.approval?.state !== "changes_requested") return finalizeAll(e.post.id, outcomeLine(e.post, "withdrawn"));
      return;
    case "post.failed":
      return broadcast(`❌ ${postName(e.post)} failed to publish.\n${e.post.error ?? ""}\n${postLink(e.post.id)}`);
    case "post.due":
      return broadcast(`⏰ ${postName(e.post)} needs you: ${e.post.error ?? "post it by hand (manual mode)."}\n${postLink(e.post.id)}`);
    case "publishing.paused":
      return broadcast(`⏸ Publishing paused by ${e.by.replace(/^owner:/, "")}${e.reason ? `: ${e.reason}` : ""}. Nothing goes out until you resume.`, [
        { label: "▶️ Resume publishing", action: "resume" },
      ]);
    case "publishing.resumed":
      return broadcast(`▶️ Publishing resumed by ${e.by.replace(/^owner:/, "")}.`);
    default:
      return;
  }
}

/** Something the person should know now (e.g. an account whose token expired). */
export function alert(text: string): void {
  void broadcast(text).catch((err) => console.warn(`[notify] ${(err as Error).message}`));
}

// ---------- the person's side ----------

const handlers: ChannelHandlers = {
  act: (who, action, postId, note) =>
    runAs({ kind: "owner", via: who }, async () => {
      if (action === "pause") {
        pausePublishing(note ?? null);
        return "⏸ Paused. Nothing will be published until you resume.";
      }
      if (action === "resume") {
        resumePublishing();
        return "▶️ Resumed.";
      }
      if (!postId || !getPost(postId)) return "That post no longer exists.";
      const decision = action === "approve" ? "approve" : action === "reject" ? "reject" : "request_changes";
      const post = decide(postId, decision, note ?? null);
      return outcomeLine(post, action === "approve" ? "post.approved" : action === "reject" ? "post.rejected" : "post.changes_requested");
    }),
  command: (who, command: Command, arg) =>
    runAs({ kind: "owner", via: who }, async () => {
      switch (command) {
        case "pending":
          return pendingText();
        case "status":
          return digestText();
        case "pause":
          pausePublishing(arg ?? null);
          return "⏸ Paused. Nothing will be published until /resume.";
        case "resume":
          if (!pauseState()) return "Publishing isn't paused.";
          resumePublishing();
          return "▶️ Resumed.";
        case "run": {
          const run = await requestRun(`chat:${who}`, arg?.trim() || undefined);
          return `🤖 Operator run started (${run.id.slice(0, 8)}). Its summary will come here.`;
        }
      }
    }),
  postForRef: (ref) => (db.prepare("SELECT post_id FROM approval_messages WHERE ref = ?").get(ref) as { post_id: string } | undefined)?.post_id ?? null,
};

/** Wrapper so a failing chat never breaks the action that caused the event. */
const safe = (what: string, p: Promise<unknown>) => p.catch((err) => console.warn(`[notify] ${what}: ${(err as Error).message}`));

const DIGEST_KEY = "digest.lastDate";

function digestDue(): boolean {
  const time = getConfig().digest.time;
  if (!time) return false;
  const [h, m] = time.split(":").map(Number) as [number, number];
  const now = new Date();
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: getConfig().timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const [lh, lm] = local.split(":").map(Number) as [number, number];
  return lh * 60 + lm >= h * 60 + m && kv.get<string>(DIGEST_KEY) !== localDateKey();
}

export async function sendDigest(): Promise<void> {
  kv.set(DIGEST_KEY, localDateKey());
  await broadcast(await digestText(), pauseState() ? [{ label: "▶️ Resume publishing", action: "resume" }] : undefined);
}

/** Re-send requests whose chat messages were never delivered (chat added later, or it was down). */
async function resendUndelivered(): Promise<void> {
  for (const p of listAwaiting()) {
    if (p.approval?.state === "pending" && !openRefs(p.id).length) await requestApproval(p);
  }
}

export function startNotify(): () => void {
  const channels = new Set(active());
  for (const c of channels) c.start(handlers);
  // Plugins switched on or off (or installed) while running bring their chats with them.
  const offChannels = onChannelsChange(({ added, removed }) => {
    for (const c of removed) if (channels.delete(c)) c.stop();
    for (const c of added) {
      if (!c.configured() || channels.has(c)) continue;
      channels.add(c);
      c.start(handlers);
    }
  });
  const off = bus.on((e) => void safe(e.type, onEvent(e)));
  if (channels.size) void safe("resend", resendUndelivered());
  const timer = setInterval(() => {
    if (active().length && digestDue()) void safe("digest", sendDigest());
  }, 60_000);
  timer.unref();
  return () => {
    off();
    offChannels();
    clearInterval(timer);
    for (const c of channels) c.stop();
  };
}

/** A test message to every configured chat (setup check). */
export async function testChannels(): Promise<ChannelStatus[]> {
  const hello = "👋 Yaypost is connected. Approval requests, alerts and the daily digest will arrive here.";
  await Promise.all(active().map((c) => c.send({ text: [hello, c.commandsHint].filter(Boolean).join("\n") })));
  return channelStatuses();
}
