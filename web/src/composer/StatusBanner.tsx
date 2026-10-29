// Banner above the thread for posts that need attention: due (missed its time), failed, publishing, published.
// Each destination is listed with its own status, link and failure reason.
import { useMutation } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Copy, ExternalLink, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import type { Health, Post } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { TargetList } from "../components/TargetStatus.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { usePlatforms } from "../lib/platforms.tsx";
import { openPost } from "../lib/router.ts";
import { formatWhen } from "../lib/time.ts";
import { cx } from "../lib/util.ts";

interface Props {
  post: Post;
  health: Health;
  /** Saves pending edits; actions that publish wait for it so the latest text goes out. */
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
      const ok = r.targets.filter((t) => t.status === "published").length;
      toast(
        r.status === "published"
          ? { id: `published-${r.id}`, title: `Published to ${ok === 1 ? "1 destination" : `all ${ok} destinations`}`, tone: "success" }
          : { id: `failed-${r.id}`, title: `Still failing: ${r.targets.length - ok} of ${r.targets.length} destinations`, tone: "error" },
      );
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
  const where = [...new Set(post.targets.map((t) => platforms.name(t.platform)))].join(", ");
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
            <ExternalLink size={14} /> View
          </a>
        )}
        <button onClick={() => duplicate.mutate()} disabled={duplicate.isPending} className={secondary}>
          <Copy size={14} /> Duplicate as draft
        </button>
      </Shell>
    );

  if (post.status === "failed") {
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
          {multi ? <TargetList post={post} className="pl-6" /> : post.error && <p className="pl-6 text-sm break-words opacity-80">{post.error}</p>}
          <div className="flex flex-wrap gap-2 pl-6">
            {retryButton(ok ? "Retry the failed ones" : "Retry")}
          </div>
        </div>
      </Shell>
    );
  }

  // Missed its time while the server was off.
  if (post.status === "due")
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

  return null;
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
