// Domain service: every surface (REST, MCP, CLI via REST, scheduler) goes through these functions,
// so state changes always emit events for SSE, webhooks and push.
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { splitThread } from "../shared/thread.ts";
import type { ApprovalState, Media, PlatformId, Post, PostSource, PostStatus, PostTarget, Segment, TargetMetrics, TargetStatus } from "../shared/types.ts";
import { actorLabel, currentActor } from "./actor.ts";
import { getConfig } from "./config.ts";
import { db, tx } from "./db.ts";
import { env } from "./env.ts";
import { platformName, threadModeOf } from "./plugins.ts";
import { bus } from "./events.ts";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
/** Invalid input from a caller; errorResponse maps the status to a 400. */
export class BadInputError extends Error {
  status = 400;
}

const now = () => new Date().toISOString();
const newId = () => randomUUID();

// ---------- posts ----------

interface PostRow {
  id: string;
  title: string | null;
  status: PostStatus;
  thread: string;
  scheduled_at: string | null;
  published_at: string | null;
  error: string | null;
  url: string | null;
  source: PostSource;
  approval: ApprovalState | null;
  approval_note: string | null;
  approval_by: string | null;
  approval_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TargetRow {
  account_id: string;
  metrics: string | null;
  snapshot: number;
  platform: PlatformId;
  thread: string | null;
  status: TargetStatus;
  external_ids: string;
  url: string | null;
  error: string | null;
  published_at: string | null;
}

function targetsOf(postId: string): PostTarget[] {
  const rows = db
    .prepare(
      `SELECT t.account_id, t.snapshot, t.metrics, a.platform, t.thread, t.status, t.external_ids, t.url, t.error, t.published_at
       FROM post_targets t JOIN accounts a ON a.id = t.account_id WHERE t.post_id = ? ORDER BY t.position`,
    )
    .all(postId) as unknown as TargetRow[];
  return rows.map((r) => ({
    accountId: r.account_id,
    platform: r.platform,
    thread: r.thread ? JSON.parse(r.thread) : null,
    snapshot: r.snapshot === 1,
    status: r.status,
    externalIds: JSON.parse(r.external_ids),
    url: r.url,
    error: r.error,
    publishedAt: r.published_at,
    metrics: r.metrics ? JSON.parse(r.metrics) : null,
  }));
}

function toPost(r: PostRow): Post {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    thread: JSON.parse(r.thread),
    scheduledAt: r.scheduled_at,
    publishedAt: r.published_at,
    error: r.error,
    url: r.url,
    targets: targetsOf(r.id),
    approval: r.approval ? { state: r.approval, note: r.approval_note, by: r.approval_by, at: r.approval_at } : null,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface SegmentInput {
  id?: string;
  text: string;
  mediaIds?: string[];
}

/**
 * Accepts either structured segments or one string with "---" separators. When `previous` is given and the
 * input is plain text, segment ids and images carry over by position, so editing text never drops images.
 */
export function normalizeThread(input: { thread?: SegmentInput[]; text?: string }, previous: Segment[] = []): Segment[] {
  const parts: SegmentInput[] =
    input.thread ??
    (input.text !== undefined
      ? splitThread(input.text).map((text, i) => ({ id: previous[i]?.id, text, mediaIds: previous[i]?.mediaIds }))
      : []);
  const segments = parts.map((p) => ({ id: p.id ?? newId(), text: p.text, mediaIds: p.mediaIds ?? [] }));
  return segments.length ? segments : [{ id: newId(), text: "", mediaIds: [] }];
}

function assertTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new BadInputError(`Invalid date: ${iso}`);
  return t.toISOString();
}

export function getPost(id: string): Post | undefined {
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
  return row ? toPost(row) : undefined;
}

export function requirePost(id: string): Post {
  const post = getPost(id);
  if (!post) throw new NotFoundError(`Post ${id} not found`);
  return post;
}

export interface ListFilter {
  status?: PostStatus[];
  from?: string; // scheduled_at >= from
  to?: string; // scheduled_at < to
  limit?: number;
}

export function listPosts(filter: ListFilter = {}): Post[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status?.length) {
    where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
    params.push(...filter.status);
  }
  if (filter.from) {
    where.push("scheduled_at >= ?");
    params.push(assertTime(filter.from));
  }
  if (filter.to) {
    where.push("scheduled_at < ?");
    params.push(assertTime(filter.to));
  }
  const sql =
    `SELECT * FROM posts ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
    `ORDER BY COALESCE(scheduled_at, updated_at) ${filter.from || filter.to ? "ASC" : "DESC"} LIMIT ?`;
  params.push(filter.limit ?? 500);
  return (db.prepare(sql).all(...params) as unknown as PostRow[]).map(toPost);
}

export interface TargetInput {
  accountId: string;
  /** A version of the thread just for this account; null = the post's own thread; absent = keep the current choice. */
  thread?: SegmentInput[] | null;
}

export function createPost(input: {
  thread?: SegmentInput[];
  text?: string;
  title?: string | null;
  scheduledAt?: string | null;
  targets?: TargetInput[];
  source: PostSource;
}): Post {
  const id = newId();
  const ts = now();
  const scheduledAt = input.scheduledAt ? assertTime(input.scheduledAt) : null;
  const thread = normalizeThread(input);
  let asks = false;
  tx(() => {
    db.prepare(
      `INSERT INTO posts (id, title, status, thread, scheduled_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.title ?? null, scheduledAt ? "scheduled" : "draft", JSON.stringify(thread), scheduledAt, input.source, ts, ts);
    if (input.targets) writeTargets(id, input.targets, [], thread);
    if (scheduledAt) assertDestinations(requirePost(id));
    asks = Boolean(scheduledAt) && needsApproval(requirePost(id));
    if (asks) setApproval(id, "pending", null);
  });
  const post = requirePost(id);
  bus.emit({ type: "post.created", post });
  if (scheduledAt) bus.emit({ type: "post.scheduled", post });
  if (asks) bus.emit({ type: "post.approval_requested", post });
  return post;
}

const EDITABLE: PostStatus[] = ["draft", "scheduled", "due", "failed"];

/**
 * Items of `before` that are already live somewhere can't change (Retry resumes after them by position): keep their
 * ids and refuse edits, removals or reordering of that prefix.
 */
function lockLivePrefix(before: Segment[], after: Segment[], live: number, where: string): Segment[] {
  for (let i = 0; i < live && i < before.length; i++) {
    const b = before[i]!;
    const a = after[i];
    if (!a || a.text.trim() !== b.text.trim() || a.mediaIds.join() !== b.mediaIds.join()) {
      throw new ConflictError(
        `The first ${live} post${live > 1 ? "s are" : " is"} already live on ${where} and can't be changed, removed or reordered. ` +
          `Edit only the posts after ${live > 1 ? "them" : "it"}, then Retry.`,
      );
    }
    after[i] = { ...a, id: b.id };
  }
  return after;
}

/** How many leading posts of the shared thread are live on some unfinished destination. */
function sharedLive(post: Post): { live: number; where: string } {
  let live = 0;
  let where = "";
  for (const t of post.targets) {
    if (t.thread || t.status === "published" || threadModeOf(t.platform) === "single") continue;
    if (t.externalIds.length > live) {
      live = t.externalIds.length;
      where = platformName(t.platform);
    }
  }
  return { live, where };
}

// ---------- approval gate ----------

/** Scheduling, publishing and retrying all need somewhere to go. */
function assertDestinations(post: Post): void {
  if (!post.targets.length) throw new ConflictError("This post has no destinations. Choose at least one connected account (GET /api/accounts) first.");
}

/** Whether the current actor needs the person's approval before this post may go out. */
export function needsApproval(post: Post): boolean {
  if (currentActor().kind !== "agent") return false;
  const { require, except } = getConfig().approval;
  if (require === "never") return false;
  return !post.targets.every((t) => except.includes(t.platform));
}

/** What an approval covers: the content and where it goes. */
const contentKey = (p: Post) =>
  JSON.stringify([p.thread.map((s) => [s.text, s.mediaIds]), p.targets.map((t) => [t.accountId, t.thread?.map((s) => [s.text, s.mediaIds]) ?? null])]);

function setApproval(id: string, state: ApprovalState | null, note: string | null): void {
  db.prepare("UPDATE posts SET approval = ?, approval_note = ?, approval_by = ?, approval_at = ?, updated_at = ? WHERE id = ?").run(
    state,
    note,
    state ? actorLabel() : null,
    state ? now() : null,
    now(),
    id,
  );
}

/** A post waiting on the person can't go out yet; a clear message for whoever tried. */
function assertNotAwaiting(post: Post): void {
  if (post.approval?.state === "pending") {
    throw new ConflictError("This post is waiting for the person's approval (sent to them in Yaypost, Telegram or Discord); it goes out once they approve.");
  }
  if (post.approval?.state === "changes_requested") {
    throw new ConflictError(`The person asked for changes before this can go out: "${post.approval.note ?? ""}". Revise it with update_post, which asks them again.`);
  }
}

/**
 * The current actor wants this post out (schedule, publish now, retry, append). Returns true when it must wait for
 * the person: the request is recorded as pending. The person's own request approves pending content.
 */
function gate(post: Post): "asks" | "approved" | null {
  if (needsApproval(post)) {
    if (post.approval?.state === "approved") return null;
    setApproval(post.id, "pending", null);
    return "asks";
  }
  if (currentActor().kind === "owner" && (post.approval?.state === "pending" || post.approval?.state === "changes_requested")) {
    setApproval(post.id, "approved", null);
    return "approved";
  }
  return null;
}

/** Emit what gate() decided, after the transaction. */
function emitGate(outcome: ReturnType<typeof gate>, post: Post): void {
  if (outcome === "asks") bus.emit({ type: "post.approval_requested", post });
  if (outcome === "approved") bus.emit({ type: "post.approved", post });
}

/**
 * "Publish now" or "retry" asked by the current actor. When the person must approve first, the post is queued for
 * right now and the request goes to them; that post is returned and nothing is published. Otherwise null: go ahead.
 */
export function holdForApproval(id: string): Post | null {
  const post = requirePost(id);
  if (!EDITABLE.includes(post.status)) throw new ConflictError(`Post is ${post.status}`);
  if (currentActor().kind === "agent") assertNotAwaiting(post);
  assertDestinations(post);
  let outcome: ReturnType<typeof gate> = null;
  tx(() => {
    outcome = gate(post);
    if (outcome === "asks") {
      db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL, updated_at = ? WHERE id = ?").run(now(), now(), id);
    }
  });
  const updated = requirePost(id);
  if (outcome === "asks") bus.emit({ type: "post.scheduled", post: updated });
  emitGate(outcome, updated);
  return outcome === "asks" ? updated : null;
}

export type Decision = "approve" | "reject" | "request_changes";

/**
 * The person's decision on a post an agent queued. Approve: it goes out at its time (now, if that has passed).
 * Request changes: it stays queued but blocked, with the note for the agent. Reject: back to drafts.
 */
export function decide(id: string, decision: Decision, note: string | null = null): Post {
  const post = requirePost(id);
  const state = post.approval?.state;
  if (state !== "pending" && state !== "changes_requested") {
    throw new ConflictError(state ? `This post is already ${state.replace("_", " ")}.` : "This post isn't waiting for approval.");
  }
  if (decision === "request_changes" && !note?.trim()) throw new BadInputError("Say what to change.");
  tx(() => {
    if (decision === "approve") {
      setApproval(id, "approved", note);
      db.prepare("UPDATE posts SET scheduled_at = ? WHERE id = ? AND status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at < ?)").run(now(), id, now());
    } else if (decision === "reject") {
      setApproval(id, "rejected", note);
      if (EDITABLE.includes(post.status)) db.prepare("UPDATE posts SET status = 'draft', scheduled_at = NULL WHERE id = ?").run(id);
    } else setApproval(id, "changes_requested", note!.trim());
  });
  const updated = requirePost(id);
  const type = decision === "approve" ? "post.approved" : decision === "reject" ? "post.rejected" : "post.changes_requested";
  bus.emit({ type, post: updated });
  return updated;
}

/** Posts the person hasn't decided on, and posts sent back to the agent with feedback. */
export function listAwaiting(): Post[] {
  return (
    db.prepare("SELECT * FROM posts WHERE approval IN ('pending', 'changes_requested') ORDER BY approval_at").all() as unknown as PostRow[]
  ).map(toPost);
}

/**
 * Autosave target. Editing a published or in-flight post is refused, and so is changing the posts of a
 * partly published thread that are already live (Retry resumes after them by position).
 */
export function updatePost(
  id: string,
  patch: { thread?: SegmentInput[]; text?: string; title?: string | null; targets?: TargetInput[] },
): Post {
  const post = requirePost(id);
  if (!EDITABLE.includes(post.status)) throw new ConflictError(`Post is ${post.status} and can no longer be edited`);
  let thread = post.thread;
  if (patch.thread !== undefined || patch.text !== undefined) {
    const { live, where } = sharedLive(post);
    thread = lockLivePrefix(post.thread, normalizeThread(patch, post.thread), live, where);
  }
  const title = patch.title !== undefined ? patch.title : post.title;
  let asks = false;
  tx(() => {
    db.prepare("UPDATE posts SET thread = ?, title = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(thread), title, now(), id);
    if (patch.targets) writeTargets(id, patch.targets, post.targets, thread);
    // Approval covers content and destinations: an agent changing either on a post in review (or already
    // approved) asks again. The person's own edits don't.
    const after = requirePost(id);
    const reviewed = post.approval && post.approval.state !== "rejected";
    if (reviewed && contentKey(after) !== contentKey(post) && needsApproval(after)) {
      setApproval(id, "pending", null);
      asks = true;
    }
  });
  const updated = requirePost(id);
  bus.emit({ type: "post.updated", post: updated });
  if (asks) bus.emit({ type: "post.approval_requested", post: updated });
  return updated;
}

/**
 * Replace a post's destinations. Existing targets keep their progress; a target with posts already live can't be
 * dropped until it is published, and its own thread keeps its live prefix.
 */
function writeTargets(postId: string, targets: TargetInput[], existing: PostTarget[], shared: Segment[]): void {
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.accountId)) throw new BadInputError(`Account ${t.accountId} is listed twice`);
    seen.add(t.accountId);
    if (!db.prepare("SELECT 1 FROM accounts WHERE id = ? AND removed_at IS NULL").get(t.accountId) && !existing.some((e) => e.accountId === t.accountId)) {
      throw new BadInputError(`Unknown account ${t.accountId}. List accounts with GET /api/accounts.`);
    }
  }
  for (const old of existing) {
    if (!seen.has(old.accountId) && old.externalIds.length && old.status !== "published") {
      throw new ConflictError(`${platformName(old.platform)} already has part of this thread live; it can't be removed until it's finished.`);
    }
  }
  // Published destinations are history: they stay, whatever the new list says.
  const kept = existing.filter((e) => e.status === "published" && !seen.has(e.accountId)).map((e) => ({ accountId: e.accountId }));
  db.prepare("DELETE FROM post_targets WHERE post_id = ?").run(postId);
  [...targets, ...kept].forEach((t: TargetInput, position) => {
    const old = existing.find((e) => e.accountId === t.accountId);
    let thread: Segment[] | null =
      t.thread === undefined || old?.status === "published"
        ? (old?.thread ?? null)
        : t.thread
          ? normalizeThread({ thread: t.thread }, old?.thread ?? [])
          : null;
    // What is live on this destination came from its own version or the shared thread; whichever it publishes
    // next (switching either way included) must start with exactly those posts.
    if (old && old.status !== "published" && old.externalIds.length && threadModeOf(old.platform) !== "single") {
      const name = platformName(old.platform);
      // A shared-thread destination's live prefix is already locked on `shared` by updatePost (sharedLive).
      const before = old.thread ?? shared;
      if (thread) thread = lockLivePrefix(before, thread, old.externalIds.length, name);
      else lockLivePrefix(before, structuredClone(shared), old.externalIds.length, name);
    }
    db.prepare(
      `INSERT INTO post_targets (post_id, account_id, position, thread, snapshot, status, external_ids, url, error, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      postId,
      t.accountId,
      position,
      thread ? JSON.stringify(thread) : null,
      old?.status === "published" && old.snapshot ? 1 : 0,
      old?.status ?? "pending",
      JSON.stringify(old?.externalIds ?? []),
      old?.url ?? null,
      old?.error ?? null,
      old?.publishedAt ?? null,
    );
  });
}

/** Progress of one destination, saved after every item so a failure or crash never re-posts it. */
export function recordTargetProgress(postId: string, accountId: string, externalIds: string[]): void {
  db.prepare("UPDATE post_targets SET external_ids = ? WHERE post_id = ? AND account_id = ?").run(JSON.stringify(externalIds), postId, accountId);
}

/** Links that come from a remote platform are only kept if they are plain http(s) (never javascript: or data:). */
export const httpUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);

/**
 * `posted` is what went out. A destination that used the shared thread keeps it as a snapshot, so later edits of the
 * shared thread (to fix another destination) never rewrite what this one shows as published.
 */
export function markTargetPublished(
  postId: string,
  accountId: string,
  result: { externalIds: string[]; url: string | null; posted: Segment[] },
): void {
  db.prepare("UPDATE post_targets SET thread = ?, snapshot = 1 WHERE post_id = ? AND account_id = ? AND thread IS NULL").run(
    JSON.stringify(result.posted),
    postId,
    accountId,
  );
  db.prepare(
    "UPDATE post_targets SET status = 'published', external_ids = ?, url = ?, error = NULL, published_at = ? WHERE post_id = ? AND account_id = ?",
  ).run(JSON.stringify(result.externalIds), httpUrl(result.url), now(), postId, accountId);
}

export function setTargetMetrics(postId: string, accountId: string, metrics: TargetMetrics): void {
  db.prepare("UPDATE post_targets SET metrics = ? WHERE post_id = ? AND account_id = ?").run(JSON.stringify(metrics), postId, accountId);
}

/**
 * Continue a published thread with more posts (e.g. a follow-up or a plug once it took off). Every destination
 * that threads (replies/messages) re-opens and, when published, resumes after what is already live, so the new
 * posts reply to the last one. LinkedIn-style single posts can't be continued and stay as they are.
 */
export function appendToPost(id: string, add: { text?: string; thread?: SegmentInput[] }, at: string | null): Post {
  const post = requirePost(id);
  if (post.status !== "published") throw new ConflictError(`Only published posts can be continued; this one is ${post.status}.`);
  const extra = normalizeThread(add).filter((s) => s.text.trim() || s.mediaIds.length);
  if (!extra.length) throw new BadInputError("Nothing to append: give text (posts separated by ---) or thread.");
  const continuable = post.targets.filter((t) => threadModeOf(t.platform) !== "single");
  if (!continuable.length) {
    throw new ConflictError("None of this post's destinations can be continued (LinkedIn posts aren't threads).");
  }
  let asks = false;
  tx(() => {
    db.prepare("UPDATE posts SET thread = ?, status = 'scheduled', scheduled_at = ?, error = NULL, updated_at = ? WHERE id = ?").run(
      JSON.stringify([...post.thread, ...extra]),
      at ?? now(),
      now(),
      id,
    );
    // New content: an earlier approval doesn't cover it.
    if (needsApproval(post)) {
      setApproval(id, "pending", null);
      asks = true;
    }
    for (const t of continuable) {
      db.prepare("UPDATE post_targets SET thread = ?, snapshot = 0, status = 'pending', error = NULL WHERE post_id = ? AND account_id = ?").run(
        JSON.stringify([...(t.thread ?? post.thread), ...extra]),
        id,
        t.accountId,
      );
    }
  });
  const updated = requirePost(id);
  bus.emit({ type: "post.scheduled", post: updated });
  if (asks) bus.emit({ type: "post.approval_requested", post: updated });
  return updated;
}

export function markTargetFailed(postId: string, accountId: string, error: string): void {
  db.prepare("UPDATE post_targets SET status = 'failed', error = ? WHERE post_id = ? AND account_id = ?").run(error, postId, accountId);
}

export function deletePost(id: string): void {
  const post = requirePost(id);
  if (post.status === "publishing") throw new ConflictError("Post is being published right now");
  db.prepare("DELETE FROM posts WHERE id = ?").run(id);
  bus.emit({ type: "post.deleted", id });
}

export function schedulePost(id: string, at: string): Post {
  const post = requirePost(id);
  if (!EDITABLE.includes(post.status)) throw new ConflictError(`Post is ${post.status} and cannot be rescheduled`);
  assertDestinations(post);
  let outcome: ReturnType<typeof gate> = null;
  tx(() => {
    db.prepare("UPDATE posts SET status = 'scheduled', scheduled_at = ?, error = NULL, updated_at = ? WHERE id = ?").run(
      assertTime(at),
      now(),
      id,
    );
    // An agent rescheduling a post that is still waiting (on the person, or on its own revision) doesn't ask again.
    const waiting = post.approval?.state === "pending" || post.approval?.state === "changes_requested";
    if (!(waiting && currentActor().kind === "agent")) outcome = gate(post);
  });
  const updated = requirePost(id);
  bus.emit({ type: "post.scheduled", post: updated });
  emitGate(outcome, updated);
  return updated;
}

export function unschedulePost(id: string): Post {
  const post = requirePost(id);
  if (!EDITABLE.includes(post.status)) throw new ConflictError(`Post is ${post.status}`);
  db.prepare("UPDATE posts SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?").run(now(), id);
  // Taken off the queue: an open approval request is withdrawn (scheduling it again asks again).
  if (post.approval?.state === "pending" || post.approval?.state === "changes_requested") setApproval(id, null, null);
  const updated = requirePost(id);
  bus.emit({ type: "post.updated", post: updated });
  return updated;
}

/**
 * Atomically move the single earliest due `scheduled` post to `publishing`. Claiming one at a time means a restart
 * mid-tick strands only the post in flight; the rest stay `scheduled` for the next tick.
 */
export function claimNextDuePost(at = new Date()): Post | undefined {
  return tx(() => {
    const row = db
      .prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ? AND (approval IS NULL OR approval = 'approved') ORDER BY scheduled_at, created_at LIMIT 1")
      .get(at.toISOString()) as { id: string } | undefined;
    if (!row) return undefined;
    db.prepare("UPDATE posts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'").run(now(), row.id);
    return requirePost(row.id);
  });
}

/** Claim one specific post for an immediate "publish now". Its time becomes now, so it shows up on today's queue. */
export function claimPost(id: string): Post {
  const post = requirePost(id);
  if (!EDITABLE.includes(post.status)) throw new ConflictError(`Post is ${post.status}`);
  if (currentActor().kind === "agent") assertNotAwaiting(post);
  const ts = now();
  const res = db
    .prepare("UPDATE posts SET status = 'publishing', scheduled_at = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(ts, ts, id, post.status);
  if (res.changes !== 1) throw new ConflictError("Post changed while claiming it; try again");
  return requirePost(id);
}

function logAttempt(postId: string, ok: boolean, detail: string | null) {
  db.prepare("INSERT INTO attempts (post_id, at, ok, detail) VALUES (?, ?, ?, ?)").run(postId, now(), ok ? 1 : 0, detail);
}

export function markPublished(id: string, url: string | null): Post {
  const post = requirePost(id);
  const ts = now();
  db.prepare(
    `UPDATE posts SET status = 'published', published_at = ?, error = NULL, url = ?,
       scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?`,
  ).run(ts, url ?? post.url, ts, ts, id);
  logAttempt(id, true, url);
  const updated = requirePost(id);
  bus.emit({ type: "post.published", post: updated });
  return updated;
}

/**
 * The user posted it by hand (e.g. a due post that missed its time). Idempotent: an already published post is returned
 * unchanged without a second event; an in-flight publish is refused.
 */
export function markPublishedManually(id: string, url?: string | null): Post {
  const post = requirePost(id);
  if (post.status === "publishing") throw new ConflictError("Post is being published right now");
  if (post.status === "published") return post;
  if (url != null && !/^https?:\/\/\S+$/i.test(url)) throw new BadInputError("url must be an http(s) link to the published post");
  return markPublished(id, url ?? null);
}

export function markFailed(id: string, error: string): Post {
  db.prepare("UPDATE posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  logAttempt(id, false, error);
  const updated = requirePost(id);
  bus.emit({ type: "post.failed", post: updated });
  return updated;
}

/**
 * Hand over to the human (notification + copy button): the post missed its time by too much to go out unattended.
 * `note` explains why and is shown with the post.
 */
export function markDue(id: string, note: string): Post {
  db.prepare("UPDATE posts SET status = 'due', error = ?, updated_at = ? WHERE id = ?").run(note, now(), id);
  logAttempt(id, false, note);
  const updated = requirePost(id);
  bus.emit({ type: "post.due", post: updated });
  return updated;
}

/** After a crash, posts stuck in `publishing` may or may not be live. Fail them loudly rather than risk duplicates. */
export function recoverInterrupted(): number {
  const stuck = listPosts({ status: ["publishing"] });
  for (const p of stuck) {
    const notes = p.targets
      .filter((t) => t.status !== "published")
      .map((t) => {
        const name = platformName(t.platform);
        markTargetFailed(p.id, t.accountId, `Interrupted while publishing (process restarted); ${t.externalIds.length} item(s) confirmed live.`);
        return `${name}: ${t.externalIds.length} confirmed live; check ${name} for item ${t.externalIds.length + 1} before you Retry (it may have gone out unrecorded).`;
      });
    markFailed(p.id, `Interrupted while publishing (process restarted). ${notes.join(" · ")}`);
  }
  return stuck.length;
}

export function attemptsFor(postId: string): { at: string; ok: boolean; detail: string | null }[] {
  return (db.prepare("SELECT at, ok, detail FROM attempts WHERE post_id = ? ORDER BY id DESC LIMIT 50").all(postId) as {
    at: string;
    ok: number;
    detail: string | null;
  }[]).map((r) => ({ at: r.at, ok: r.ok === 1, detail: r.detail }));
}

// ---------- media ----------

interface MediaRow {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string | null;
  path: string;
  created_at: string;
}

export const IMAGE_MIMES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // X's limit for images

/** Files live in <DATA_DIR>/media; rows store only the file name so data/ can be moved or restored elsewhere. */
const mediaFile = (stored: string) => path.join(env.dataDir, "media", path.basename(stored));

function toMedia(r: MediaRow): Media {
  return { id: r.id, filename: r.filename, mime: r.mime, size: r.size, alt: r.alt, url: `/media/${r.id}`, createdAt: r.created_at };
}

export function createMedia(input: { data: Uint8Array; mime: string; filename?: string; alt?: string | null }): Media {
  const ext = IMAGE_MIMES[input.mime];
  if (!ext) throw new ConflictError(`Unsupported image type ${input.mime}; use png, jpeg, webp or gif`);
  if (input.data.byteLength > MAX_IMAGE_BYTES) throw new ConflictError("Image is larger than X's 5 MB limit");
  const id = newId();
  const name = `${id}.${ext}`;
  writeFileSync(mediaFile(name), input.data);
  db.prepare("INSERT INTO media (id, filename, mime, size, alt, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    input.filename ?? `${id}.${ext}`,
    input.mime,
    input.data.byteLength,
    input.alt ?? null,
    name,
    now(),
  );
  return toMedia(db.prepare("SELECT * FROM media WHERE id = ?").get(id) as unknown as MediaRow);
}

export function getMedia(id: string): (Media & { path: string }) | undefined {
  const r = db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
  return r ? { ...toMedia(r), path: mediaFile(r.path) } : undefined;
}

export function readMediaBytes(id: string): Buffer {
  const m = getMedia(id);
  if (!m) throw new NotFoundError(`Media ${id} not found`);
  return readFileSync(m.path);
}

export function updateMediaAlt(id: string, alt: string | null): Media {
  if (!getMedia(id)) throw new NotFoundError(`Media ${id} not found`);
  db.prepare("UPDATE media SET alt = ? WHERE id = ?").run(alt, id);
  return toMedia(db.prepare("SELECT * FROM media WHERE id = ?").get(id) as unknown as MediaRow);
}

export function deleteMedia(id: string): void {
  const m = getMedia(id);
  if (!m) throw new NotFoundError(`Media ${id} not found`);
  db.prepare("DELETE FROM media WHERE id = ?").run(id);
  try {
    unlinkSync(m.path);
  } catch {
    // already gone
  }
}
