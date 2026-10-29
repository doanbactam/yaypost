// Banner above the thread for posts that need attention: due (copy & post by hand), failed, publishing, published.
// Posts with connected-account destinations list each destination's own status, link and failure reason.
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Copy, ExternalLink, LoaderCircle, RotateCcw, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Health, Post } from "../../../shared/types.ts";
import { api, liveSummary, remainingThread } from "../api.ts";
import { Popover } from "../components/Popover.tsx";
import { TargetList } from "../components/TargetStatus.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { usePlatforms } from "../lib/platforms.tsx";
import { openPost } from "../lib/router.ts";
import { formatWhen } from "../lib/time.ts";
import { copyText, cx } from "../lib/util.ts";

interface Props {
  post: Post;
  health: Health;
  /** Opened from a reminder (`?copy=1`): lead with the copy button. */
  fromReminder: boolean;
  onCopy: () => Promise<boolean>;
  onPublish: () => Promise<unknown>;
  /** Saves pending edits; actions that send the post to X wait for it so the latest text goes out. */
  flush: () => Promise<void>;
  onChange: (post: Post) => void;
}

const primary = "flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50";
const secondary = "flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm hover:bg-subtle disabled:opacity-50";

/** Retry a failed (or missed) post: resumes each destination where it stopped. Shared with the composer footer. */
export function useRetry(post: Post | null, flush: () => Promise<void>, onChange: (post: Post) => void) {
  return useMutation({
    mutationFn: async () => {
      await flush();
      return api.retry(post!.id);
    },
    onSuccess: (r) => {
      onChange(r);
      if (r.targets.length) {
        const ok = r.targets.filter((t) => t.status === "published").length;
        return toast(
          r.status === "published"
            ? { id: `published-${r.id}`, title: `Published to ${ok === 1 ? "1 destination" : `all ${ok} destinations`}`, tone: "success" }
            : { id: `failed-${r.id}`, title: `Still failing: ${r.targets.length - ok} of ${r.targets.length} destinations`, tone: "error" },
        );
      }
      toast({
        id: r.status === "published" ? `published-${r.id}` : undefined, // same id as the live "Posted to X" toast
        title: r.status === "published" ? "Posted to X" : r.status === "due" ? "Ready to post by hand" : "Retried",
        tone: "success",
        actions: r.status === "published" && r.url ? [{ label: "View on X", onClick: () => open(r.url!, "_blank", "noopener") }] : undefined,
      });
    },
    onError: (e) => toastError("Retry failed", e),
  });
}

export function StatusBanner(p: Props) {
  const { post } = p;
  const tz = p.health.timezone;
  const platforms = usePlatforms();

  const retry = useRetry(post, p.flush, p.onChange);
  const duplicate = useMutation({
    mutationFn: () => api.duplicate(post.id),
    onSuccess: (r) => openPost(r.id),
    onError: (e) => toastError("Couldn't duplicate", e),
  });

  const multi = post.targets.length > 0;
  const where = multi ? [...new Set(post.targets.map((t) => platforms.name(t.platform)))].join(", ") : "X";
  const retryButton = (label: string) => (
    <button onClick={() => retry.mutate()} disabled={retry.isPending} className={primary}>
      {retry.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />} {label}
    </button>
  );

  if (post.status === "publishing")
    return (
      <Shell tone="info">
        <LoaderCircle size={16} className="animate-spin" /> <span className="font-medium">Publishing to {where}…</span>
        {multi && <TargetList post={post} className="pl-6" />}
      </Shell>
    );

  if (post.status === "published")
    return (
      <Shell tone="ok">
        <CircleCheck size={16} className="shrink-0" />
        <span className="flex-1">
          <span className="font-medium">Published</span>
          {post.publishedAt && <span className="opacity-70"> · {formatWhen(post.publishedAt, tz)}</span>}
        </span>
        {multi && <TargetList post={post} className="order-last pl-6" />}
        {post.url && !multi && (
          <a href={post.url} target="_blank" rel="noopener noreferrer" className={secondary}>
            <ExternalLink size={14} /> View on X
          </a>
        )}
        <button onClick={() => duplicate.mutate()} disabled={duplicate.isPending} className={secondary}>
          <Copy size={14} /> Duplicate as draft
        </button>
      </Shell>
    );

  if (post.status === "failed" && multi) {
    const ok = post.targets.filter((t) => t.status === "published").length;
    return (
      <Shell tone="error">
        <div className="flex w-full flex-col gap-2.5">
          <div className="flex gap-2">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            <p className="font-medium">
              {ok ? `Published to ${ok} of ${post.targets.length} destinations` : "This post failed to publish"}
            </p>
          </div>
          <TargetList post={post} className="pl-6" />
          <div className="flex flex-wrap gap-2 pl-6">
            {retryButton(ok ? "Retry the failed ones" : "Retry")}
          </div>
        </div>
      </Shell>
    );
  }

  // Missed its time while the server was off (connected accounts never need posting by hand).
  if (post.status === "due" && multi)
    return (
      <Shell tone="due">
        <div className="flex w-full flex-col gap-2.5">
          <div>
            <p className="font-semibold">Not posted yet</p>
            {post.error && <p className="mt-0.5 text-sm break-words">{post.error}</p>}
          </div>
          <TargetList post={post} />
          <div className="flex flex-wrap gap-2">{retryButton("Publish now")}</div>
        </div>
      </Shell>
    );

  if (post.status === "failed")
    return (
      <Shell tone="error">
        <div className="flex w-full flex-col gap-2.5">
          <div className="flex gap-2">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">This post failed to publish</p>
              {post.error && <p className="mt-0.5 text-sm break-words opacity-80">{post.error}</p>}
              {post.xPostIds.length > 0 && (
                <p className="mt-1 text-sm opacity-80">
                  {liveSummary(post.xPostIds.length)} and locked here; you can still edit the posts after{" "}
                  {post.xPostIds.length > 1 ? "them" : "it"}.
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pl-6">
            <button onClick={() => retry.mutate()} disabled={retry.isPending} className={primary}>
              {retry.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />} Retry
            </button>
            <MarkPosted post={post} flush={p.flush} onChange={p.onChange} />
          </div>
        </div>
      </Shell>
    );

  if (post.status === "due" || p.fromReminder) return <DueBanner {...p} />;
  return null;
}

function DueBanner(p: Props) {
  const { post } = p;
  const [copied, setCopied] = useState<number | "all" | null>(null);
  const [publishing, setPublishing] = useState(false);
  // A thread that stopped partway on X: only the rest is posted by hand, as replies under the last live post.
  const { live, rest, replyToUrl, intent } = remainingThread(post);
  const multi = rest.length > 1;
  const apiMode = p.health.x.mode === "api";
  return (
    <Shell tone="due">
      <div className="flex w-full flex-col gap-3">
        <div>
          <p className="font-semibold">{post.status === "due" ? "Time to post" : "Ready to post"}</p>
          {/* Why a human is needed (e.g. it missed its time); the server's own "already live" note is said below, with a link. */}
          {post.status === "due" && post.error && !(live > 0 && post.error.includes("already live on X")) && (
            <p className="mt-0.5 text-sm break-words">{post.error}</p>
          )}
          {live > 0 ? (
            <p className="mt-0.5 text-sm">
              {liveSummary(live)}. Post the remaining {rest.length} as {multi ? "replies" : "a reply"} to{" "}
              <a href={replyToUrl!} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
                post {live} on X
              </a>
              , then mark it posted.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {apiMode && post.status === "due" && (
            <button
              onClick={() => {
                setPublishing(true);
                void p.onPublish().finally(() => setPublishing(false));
              }}
              disabled={publishing}
              className={cx(primary, "h-10 px-4")}
            >
              {publishing ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />} Publish now
            </button>
          )}
          <button
            autoFocus={p.fromReminder}
            onClick={() => void p.onCopy().then((ok) => ok && setCopied("all"))}
            className={cx(apiMode && post.status === "due" ? secondary : primary, "h-10 px-4")}
          >
            {copied === "all" ? <CircleCheck size={15} /> : <Copy size={15} />}
            {copied === "all" ? "Copied" : live > 0 ? `Copy remaining ${rest.length}` : multi ? "Copy thread" : "Copy post"}
          </button>
          <a href={intent} target="_blank" rel="noopener noreferrer" className={cx(secondary, "h-10")}>
            <ExternalLink size={14} /> {live > 0 ? `Reply to post ${live} in X` : "Open in X"}
          </a>
          <MarkPosted post={post} flush={p.flush} onChange={p.onChange} />
        </div>
        {multi && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="opacity-70">Copy one:</span>
            {rest.map((s, j) => {
              const i = live + j;
              return (
                <button
                  key={s.id}
                  onClick={() =>
                    copyText(s.text).then(
                      () => setCopied(i),
                      (e: unknown) => toastError("Couldn't copy", e),
                    )
                  }
                  className={cx(
                    "rounded-full border px-2.5 py-1 tabular-nums transition-colors",
                    copied === i ? "border-current font-medium" : "border-amber-300/70 hover:border-current dark:border-amber-800",
                  )}
                >
                  {copied === i ? "✓ " : ""}
                  {i + 1}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );
}

function MarkPosted({ post, flush, onChange }: { post: Post; flush: () => Promise<void>; onChange: (p: Post) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const mark = useMutation({
    mutationFn: async () => {
      await flush(); // the stored thread should match what was posted
      return api.markPublished(post.id, url.trim() || undefined);
    },
    onSuccess: (r) => {
      onChange(r);
      setOpen(false);
      toast({ title: "Marked as posted", tone: "success" });
    },
    onError: (e) => toastError("Couldn't mark as posted", e),
  });
  return (
    <Popover
      trigger={
        <button className={secondary}>
          <CircleCheck size={14} /> Mark posted
        </button>
      }
      open={open}
      onOpenChange={setOpen}
    >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mark.mutate();
          }}
          className="space-y-2.5 text-ink"
        >
          <label className="block text-xs font-medium text-ink-2">
            Link to the post on X (optional)
            <input
              autoFocus
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://x.com/you/status/…"
              className="mt-1 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm font-normal text-ink focus:border-line-strong"
            />
          </label>
          <button type="submit" disabled={mark.isPending} className={cx(primary, "w-full justify-center")}>
            {mark.isPending && <LoaderCircle size={14} className="animate-spin" />} Mark as posted
          </button>
        </form>
    </Popover>
  );
}

function Shell({ tone, children }: { tone: "info" | "ok" | "error" | "due"; children: ReactNode }) {
  return (
    <div
      className={cx(
        "mb-5 flex animate-rise flex-wrap items-center gap-2.5 rounded-2xl border px-4 py-3.5 text-sm",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-100",
        tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100",
        tone === "error" && "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100",
        tone === "due" && "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-50",
      )}
    >
      {children}
    </div>
  );
}
