// Queue: the next 14 days grouped by day (posts + open slots), with due/failed actions, and the published list.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CircleCheck, ExternalLink, Image, LoaderCircle, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import type { Health, Post, QueueDay, QueueItem } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { ApprovalPill } from "../components/Approval.tsx";
import { SlotsDialog } from "./SlotsDialog.tsx";
import { TimezonePicker } from "../components/TimezonePicker.tsx";
import { Tip } from "../components/Tip.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { TargetIcons, TargetList } from "../components/TargetStatus.tsx";
import { toastError } from "../components/Toasts.tsx";
import { navigate, newDraft, openPost } from "../lib/router.ts";
import { PlatformIcon, usePlatforms } from "../lib/platforms.tsx";
import { dayKey, formatDate, formatTime, formatWhen, relativeDay } from "../lib/time.ts";
import { cx } from "../lib/util.ts";

const STATUS_STYLE: Record<Post["status"], string> = {
  draft: "bg-subtle text-ink-2",
  scheduled: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  due: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  publishing: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

export function StatusBadge({ status }: { status: Post["status"] }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", STATUS_STYLE[status])}>
      {status === "publishing" && <LoaderCircle size={10} className="animate-spin" />}
      {status}
    </span>
  );
}

interface Props {
  health: Health;
  tab: "upcoming" | "published";
}

export function QueueView({ health, tab }: Props) {
  const [slots, setSlots] = useState(false);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-4 pb-24 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 pt-6 pb-4">
          <span className="flex items-center gap-2 text-xs text-ink-3">
            <TimezonePicker value={health.timezone} className="-ml-1.5 rounded-full px-1.5 py-1 hover:bg-subtle hover:text-ink" />
            <Tip content="Posting slots">
              <button
                onClick={() => setSlots(true)}
                aria-label="Posting slots"
                className="grid size-7 place-items-center rounded-full text-ink-3 hover:bg-subtle hover:text-ink"
              >
                <CalendarClock size={14} />
              </button>
            </Tip>
          </span>
          <Tabs
            label="Queue"
            value={tab}
            onChange={(t) => navigate(t === "upcoming" ? "/queue" : "/queue?tab=published", { replace: true })}
            tabs={[
              { value: "upcoming", label: "Upcoming" },
              { value: "published", label: "Published" },
            ]}
          />
        </header>
        {tab === "published" ? (
          <Published health={health} />
        ) : (
          <Upcoming health={health} />
        )}
      </div>
      {slots && <SlotsDialog onClose={() => setSlots(false)} />}
    </div>
  );
}

function Upcoming({ health }: { health: Health }) {
  const { data: queue, isPending, error } = useQuery({ queryKey: ["queue"], queryFn: () => api.queue(14), refetchInterval: 60_000 });
  const tz = queue?.timezone ?? health.timezone;
  const counts = useMemo(() => {
    const items = queue?.days.flatMap((d) => d.items) ?? [];
    return { posts: items.filter((i) => i.type === "post").length, slots: items.filter((i) => i.type === "slot").length };
  }, [queue]);

  if (isPending) return <Skeleton />;
  if (error) return <p className="py-10 text-center text-sm text-red-600">Couldn't load the queue: {error.message}</p>;

  if (!counts.posts && !counts.slots) return <NoSlots />;

  return (
    <>
      <div className="space-y-1">
        {queue.days.map((day) => (
          <Day key={day.date} day={day} tz={tz} />
        ))}
      </div>
    </>
  );
}

function Day({ day, tz }: { day: QueueDay; tz: string }) {
  const rel = relativeDay(day.date, tz);
  // Published, due and failed posts are listed too, but only scheduled ones are still "queued".
  const queued = day.items.filter((i) => i.type === "post" && i.post.status === "scheduled").length;
  return (
    <section>
      <h2 className="sticky top-0 z-10 -mx-2 flex items-baseline gap-2 bg-canvas/90 px-2 pt-4 pb-2 backdrop-blur">
        <span className="text-sm font-semibold">{rel ?? formatDate(day.date).split(",")[0]}</span>
        <span className="text-sm text-ink-3">{rel ? formatDate(day.date) : formatDate(day.date).split(", ").slice(1).join(", ")}</span>
        {queued > 0 && <span className="ml-auto text-xs text-ink-3">{queued} queued</span>}
      </h2>
      {day.items.length ? (
        <ul className="space-y-1.5">
          {day.items.map((item) => (
            <li key={item.type === "post" ? item.post.id : item.at}>
              <Row item={item} date={day.date} tz={tz} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-1 text-xs text-ink-3">—</p>
      )}
    </section>
  );
}

function Row({ item, date, tz }: { item: QueueItem; date: string; tz: string }) {
  if (item.type === "slot")
    return (
      <button
        onClick={() => newDraft(item.at)}
        className="group flex w-full items-center gap-4 rounded-xl border border-dashed border-transparent px-3 py-2 text-left text-sm text-ink-3 transition-colors hover:border-line-strong hover:bg-surface hover:text-ink-2"
      >
        <time className="w-20 shrink-0 whitespace-nowrap tabular-nums">{formatTime(item.at, tz)}</time>
        <span aria-hidden className="h-px flex-1 border-t border-dashed border-line-strong group-hover:border-transparent" />
        <span className="sr-only">Empty slot</span>
        <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-60">
          <Plus size={14} /> Write
        </span>
      </button>
    );
  return <PostRow post={item.post} at={item.at} date={date} tz={tz} />;
}

function Preview({ post }: { post: Post }) {
  const images = post.thread.reduce((n, s) => n + s.mediaIds.length, 0);
  return (
    <>
      <p className="line-clamp-2 text-sm leading-relaxed break-words">{post.thread[0]?.text.trim() || <span className="text-ink-3">Empty post</span>}</p>
      <p className="mt-1 flex items-center gap-2 text-xs text-ink-3">
        {post.thread.length > 1 && <span>{post.thread.length} posts</span>}
        {images > 0 && (
          <span className="flex items-center gap-0.5">
            <Image size={12} /> {images}
          </span>
        )}
        {post.source !== "ui" && <span>via {post.source.toUpperCase()}</span>}
        {post.targets.length > 0 && <TargetIcons post={post} />}
      </p>
    </>
  );
}

/** A scheduled post a destination would refuse at its time (edited past a limit, an image it can't take…). */
function WouldFail({ post }: { post: Post }) {
  const { data } = useQuery({
    queryKey: ["preview", post.id, post.updatedAt],
    queryFn: () => api.preview(post.id),
    staleTime: 60_000,
  });
  const bad = data?.filter((t) => t.problem) ?? [];
  if (!bad.length) return null;
  const first = bad[0]!;
  return (
    <p role="note" className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-900 dark:text-amber-300">
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-px font-medium dark:bg-amber-950">
        <TriangleAlert size={11} /> Would fail
      </span>
      <span className="line-clamp-2 min-w-0 break-words">
        {first.label}: {first.problem}
        {bad.length > 1 && ` (+${bad.length - 1} more)`}
      </span>
    </p>
  );
}

function PostRow({ post, at, date, tz }: { post: Post; at: string; date: string; tz: string }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retry(post.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["queue"] }),
    onError: (e) => toastError("Retry failed", e),
  });
  const multi = post.targets.length > 0;
  const missed = post.status === "due";
  const failed = post.status === "failed";
  const action = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium";
  // Overdue posts from earlier days are listed under today: show their own date so they don't read as today's.
  const day = dayKey(at, tz);
  const otherDay = day !== date;

  return (
    <div
      className={cx(
        "rounded-xl border transition-colors",
        missed
          ? "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30"
          : failed
            ? "border-red-200 bg-surface dark:border-red-900"
            : "border-line bg-surface",
      )}
    >
      <button onClick={() => openPost(post.id)} className="flex w-full items-start gap-4 rounded-xl px-3 py-2.5 text-left hover:bg-subtle/60">
        <time dateTime={at} className="w-20 shrink-0 pt-0.5 text-sm font-medium whitespace-nowrap tabular-nums">
          {otherDay && <span className="block text-xs font-normal text-ink-3">{relativeDay(day, tz) ?? formatDate(day).split(", ").slice(1).join(", ")}</span>}
          {formatTime(at, tz)}
        </time>
        <div className="min-w-0 flex-1">
          <Preview post={post} />
          {post.status === "scheduled" && <WouldFail post={post} />}
          {post.approval?.state === "changes_requested" && post.approval.note && (
            <p className="mt-1 line-clamp-2 text-xs break-words text-orange-800 dark:text-orange-300">You asked: “{post.approval.note}”</p>
          )}
        </div>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={post.status} />
          <ApprovalPill post={post} />
        </span>
      </button>
      {failed && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 sm:pl-27">
          {multi ? (
            <TargetList post={post} only={["failed"]} className="text-red-800 dark:text-red-200" />
          ) : (
            <p className="w-full text-xs break-words text-red-700 dark:text-red-300">{post.error ?? "Publishing failed."}</p>
          )}
          <button onClick={() => retry.mutate()} disabled={retry.isPending} className={cx(action, "bg-ink text-canvas")}>
            {retry.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCcw size={13} />}{" "}
            {multi && post.targets.some((t) => t.status === "published") ? "Retry the failed ones" : "Retry"}
          </button>
        </div>
      )}
      {missed && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 sm:pl-27">
          {post.error && <p className="w-full text-xs break-words text-amber-900 dark:text-amber-200">{post.error}</p>}
          <button onClick={() => retry.mutate()} disabled={retry.isPending} className={cx(action, "bg-ink text-canvas")}>
            {retry.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <RotateCcw size={13} />} Publish now
          </button>
        </div>
      )}
    </div>
  );
}

function Published({ health }: { health: Health }) {
  const platforms = usePlatforms();
  const { data: posts, isPending } = useQuery({
    queryKey: ["posts", "published"],
    queryFn: () => api.listPosts({ status: ["published"], limit: 100 }),
  });
  if (isPending) return <Skeleton />;
  if (!posts?.length)
    return (
      <p className="flex flex-col items-center gap-2 py-16 text-sm text-ink-3">
        <CircleCheck size={22} strokeWidth={1.5} />
        Nothing published yet
      </p>
    );
  return (
    <ul className="space-y-1.5">
      {posts.map((post) => (
        <li key={post.id} className="flex items-start gap-4 rounded-xl border border-line bg-surface px-3 py-2.5">
          <button onClick={() => openPost(post.id)} className="min-w-0 flex-1 text-left">
            <time className="text-xs text-ink-3">{post.publishedAt ? formatWhen(post.publishedAt, health.timezone) : ""}</time>
            <div className="mt-0.5">
              <Preview post={post} />
            </div>
          </button>
          {post.targets.length > 0 ? (
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              {post.targets.map((t) =>
                t.url ? (
                  <a
                    key={t.accountId}
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`View on ${platforms.name(t.platform)}`}
                    className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink"
                  >
                    <PlatformIcon platform={t.platform} size={12} /> View <ExternalLink size={11} />
                  </a>
                ) : null,
              )}
            </div>
          ) : post.url && (
            <a
              href={post.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink"
            >
              View <ExternalLink size={12} />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function NoSlots() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong px-5 py-10 text-sm text-ink-2 hover:border-ink-3 hover:text-ink"
      >
        <CalendarClock size={22} strokeWidth={1.5} />
        Add posting slots
      </button>
      {open && <SlotsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
function Skeleton() {
  return (
    <div className="space-y-2 pt-4" aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl bg-subtle" />
      ))}
    </div>
  );
}
