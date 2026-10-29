// Per-destination status of a post: a detailed list (status banner, queue) and a compact icon strip (queue rows).
import { CircleAlert, CircleCheck, Clock, ExternalLink, LoaderCircle } from "lucide-react";
import type { Post, PostTarget } from "../../../shared/types.ts";
import { PlatformIcon, removedLabel, useAccounts, usePlatforms } from "../lib/platforms.tsx";
import { cx } from "../lib/util.ts";

function useLabels() {
  const { data: accounts } = useAccounts();
  const platforms = usePlatforms();
  // An account removed after the post went out is no longer listed; the post keeps pointing at it.
  return (t: PostTarget) =>
    accounts?.find((a) => a.id === t.accountId)?.label ?? (accounts ? removedLabel(platforms, t.platform) : platforms.name(t.platform));
}

function StateIcon({ t, publishing }: { t: PostTarget; publishing: boolean }) {
  if (t.status === "published") return <CircleCheck size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Published" />;
  if (t.status === "failed") return <CircleAlert size={14} className="shrink-0 text-red-600 dark:text-red-400" aria-label="Failed" />;
  if (publishing) return <LoaderCircle size={14} className="shrink-0 animate-spin text-sky-600" aria-label="Publishing" />;
  return <Clock size={14} className="shrink-0 text-ink-3" aria-label="Waiting" />;
}

/** One row per destination: platform, account, state, link when live, the platform's reason when it failed. */
export function TargetList({ post, only, className }: { post: Post; only?: PostTarget["status"][]; className?: string }) {
  const label = useLabels();
  const platforms = usePlatforms();
  const publishing = post.status === "publishing";
  const list = post.targets.filter((t) => !only || only.includes(t.status));
  if (!list.length) return null;
  return (
    <ul className={cx("w-full space-y-1.5", className)}>
      {list.map((t) => (
        <li key={t.accountId} className="flex min-w-0 items-start gap-2 text-sm">
          <span className="mt-0.5">
            <StateIcon t={t} publishing={publishing} />
          </span>
          <PlatformIcon platform={t.platform} size={14} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{label(t)}</span>
              {t.status === "published" ? (
                t.url ? (
                  <a href={t.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline-offset-2 opacity-80 hover:underline">
                    View on {platforms.name(t.platform)} <ExternalLink size={11} />
                  </a>
                ) : (
                  <span className="text-xs opacity-70">Published</span>
                )
              ) : t.status === "failed" ? (
                <span className="text-xs opacity-70">
                  Failed{t.externalIds.length > 0 && ` · ${t.externalIds.length} live`}
                </span>
              ) : (
                <span className="text-xs opacity-70">{publishing ? "Publishing…" : "Waiting"}</span>
              )}
              {t.thread && !t.snapshot && <span className="text-xs opacity-60">own version</span>}
            </div>
            {t.status === "failed" && t.error && <p className="mt-0.5 text-xs break-words opacity-80">{t.error}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Platform glyphs with a status dot, for dense lists. */
export function TargetIcons({ post }: { post: Post }) {
  const label = useLabels();
  return (
    <span className="flex items-center gap-1.5">
      {post.targets.map((t) => (
        <span
          key={t.accountId}
          title={`${label(t)}: ${t.status === "failed" ? `failed${t.error ? ` — ${t.error}` : ""}` : t.status === "published" ? "published" : "waiting"}`}
          className="relative inline-flex"
        >
          <PlatformIcon platform={t.platform} size={12} tint={t.status !== "pending"} className={cx(t.status === "pending" && "opacity-70")} />
          {t.status !== "pending" && (
            <span
              className={cx(
                "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-surface",
                t.status === "published" ? "bg-emerald-500" : "bg-red-500",
              )}
            />
          )}
        </span>
      ))}
    </span>
  );
}
