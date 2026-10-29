// In-process scheduler: every few seconds, claim due posts one at a time and publish them to their connected
// accounts (server/publisher.ts). A post that missed its time by more than lateGraceMinutes because the server was
// off is handed to the human instead (`due`: notification + copy). Ticks never overlap; posts go out one by one.
import type { Post } from "../shared/types.ts";
import { formatLocal, getConfig } from "./config.ts";
import { assertNotPaused, pauseState } from "./control.ts";
import { claimNextDuePost, claimPost, ConflictError, holdForApproval, markDue, markFailed, requirePost } from "./repo.ts";
import { publishTargets } from "./publisher.ts";

/** Non-null when a scheduled post is too late to go out unattended (the server was off at its time). */
function lateNote(post: Post): string | null {
  const graceMinutes = getConfig().lateGraceMinutes;
  if (!graceMinutes || !post.scheduledAt || Date.now() - Date.parse(post.scheduledAt) <= graceMinutes * 60_000) return null;
  return `Missed its time, ${formatLocal(post.scheduledAt)}, while Yaypost was offline — publish now, copy it, or reschedule.`;
}

/** A claimed post whose time has come: publish it, or hand it to the human. */
async function handleDue(post: Post): Promise<void> {
  const late = lateNote(post);
  if (late) {
    markDue(post.id, late);
    console.warn(`[scheduler] ${post.id} not posted unattended: ${late}`);
    return;
  }
  await publishTargets(post);
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
  requirePost(id);
  assertNotPaused();
  const held = holdForApproval(id);
  if (held) return held;
  return publishTargets(claimPost(id));
}

/** Retry a failed post, or publish a due one (e.g. one that missed its time), resuming after what is already live. */
export async function retryPost(id: string): Promise<Post> {
  const post = requirePost(id);
  if (post.status !== "failed" && post.status !== "due") {
    throw new ConflictError(`Only failed or due posts can be retried; this one is ${post.status}.`);
  }
  assertNotPaused();
  const held = holdForApproval(id);
  if (held) return held;
  return publishTargets(claimPost(id));
}
