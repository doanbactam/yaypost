// In-process scheduler: every few seconds, claim due posts one at a time and publish them to their connected
// accounts (server/publisher.ts) or, for posts without any, through the .env X keys. Posts are handed to the human
// (`due`: notification + copy) in manual mode (no accounts, no X keys) or when the post missed its time by more than
// lateGraceMinutes because the server was off. Ticks never overlap; posts go out one by one.
import type { Post } from "../shared/types.ts";
import { formatLocal, getConfig } from "./config.ts";
import { xConfigured } from "./env.ts";
import { assertNotPaused, pauseState } from "./control.ts";
import { claimNextDuePost, claimPost, ConflictError, holdForApproval, markDue, markFailed, markPublished, requirePost } from "./repo.ts";
import { publishLegacyX, publishTargets } from "./publisher.ts";

const manualModeMessage = (id: string) =>
  `Auto-posting is off because no X API keys are configured (manual mode). Copy the thread (Copy button, or GET /api/posts/${id}/export), ` +
  `post it on x.com, then mark it published (POST /api/posts/${id}/mark-published). To auto-post, put X_API_KEY, X_API_SECRET, ` +
  `X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET from an X app with "Read and write" permission in .env and restart ` +
  `(the X API is pay-per-use: about $0.015 per post, $0.20 per post with a link).`;

/** Manual hand-off of a thread the X API already partly posted: only the rest may be posted, as replies. */
function liveNote(post: Post): string | null {
  const live = post.xPostIds.length;
  const total = post.thread.length;
  if (!live || live >= total) return null;
  const done = live === 1 ? `Post 1 of ${total} is` : `Posts 1–${live} of ${total} are`;
  const rest = live + 1 === total ? `post ${total}` : `posts ${live + 1}–${total}`;
  return `${done} already live on X. Post only ${rest}, as replies to https://x.com/i/status/${post.xPostIds[live - 1]}, then mark it published.`;
}

/** Non-null when a scheduled post is too late to go out unattended (the server was off at its time). */
function lateNote(post: Post): string | null {
  const graceMinutes = getConfig().lateGraceMinutes;
  if (!graceMinutes || !post.scheduledAt || Date.now() - Date.parse(post.scheduledAt) <= graceMinutes * 60_000) return null;
  return `Missed its time, ${formatLocal(post.scheduledAt)}, while Yaypost was offline — publish now, copy it, or reschedule.`;
}

/** Publish a post already claimed as `publishing`; failures end up on the post, never thrown. */
async function publish(post: Post): Promise<Post> {
  if (post.targets.length) return publishTargets(post);
  let result: Awaited<ReturnType<typeof publishLegacyX>>;
  try {
    result = await publishLegacyX(post);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[publish] ${post.id} failed: ${message}`);
    return markFailed(post.id, message);
  }
  console.log(`[publish] ${post.id} live (${result.xPostIds.length} posts) → ${result.url}`);
  return markPublished(post.id, result);
}

/** A claimed post whose time has come: publish it, or hand it to the human. */
async function handleDue(post: Post): Promise<void> {
  // Posts without connected accounts use the original single-X mode (.env keys, or manual copy & post).
  if (!post.targets.length && !xConfigured) {
    markDue(post.id, liveNote(post));
    console.log(`[scheduler] ${post.id} is due; manual mode, notifying`);
    return;
  }
  const late = lateNote(post);
  if (late) {
    markDue(post.id, late);
    console.warn(`[scheduler] ${post.id} not posted unattended: ${late}`);
    return;
  }
  await publish(post);
}

/**
 * Claim one due post at a time rather than all of them, so a restart mid-tick leaves the others `scheduled`
 * instead of `publishing` (which recovery would mark failed).
 */
function claimNext(): Post[] {
  if (pauseState()) return [];
  const post = claimNextDuePost();
  return post ? [post] : [];
}

function intervalMs(): number {
  try {
    return getConfig().schedulerIntervalSeconds * 1000;
  } catch {
    return 15_000;
  }
}

/** Starts ticking; the returned stop function resolves once the tick in progress (if any) has finished. */
export function startScheduler(): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      for (let batch = claimNext(); batch.length; batch = stopped ? [] : claimNext()) {
        for (const post of batch) {
          try {
            await handleDue(post);
          } catch (err) {
            console.error(`[scheduler] ${post.id}:`, err);
            markFailed(post.id, `Publishing stopped on an internal error: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] tick failed:", err);
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), intervalMs());
  };
  running = tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    return running;
  };
}

/**
 * "Publish now" from the UI/API/MCP (drafts, scheduled, due and failed posts). Resolves with the post as published or
 * failed, or, when an agent asks and the person must approve first, as scheduled for now with approval pending.
 */
export async function publishNow(id: string): Promise<Post> {
  const post = requirePost(id);
  assertNotPaused();
  if (!post.targets.length && !xConfigured) throw new ConflictError(manualModeMessage(id));
  const held = holdForApproval(id);
  if (held) return held;
  return publish(claimPost(id));
}

/**
 * Retry a failed post, or publish a due one (e.g. one that missed its time), resuming after tweets already live.
 * In manual mode it re-notifies instead.
 */
export async function retryPost(id: string): Promise<Post> {
  const post = requirePost(id);
  if (post.status !== "failed" && post.status !== "due") {
    throw new ConflictError(`Only failed or due posts can be retried; this one is ${post.status}.`);
  }
  if (!post.targets.length && !xConfigured) return markDue(id, liveNote(post));
  assertNotPaused();
  const held = holdForApproval(id);
  if (held) return held;
  return publish(claimPost(id));
}
