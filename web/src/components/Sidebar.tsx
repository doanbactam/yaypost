// Left rail for the person using the app: write, review, see what's scheduled and published, pick up a draft.
// Setup sits at the bottom; a single alert line appears above it only when something needs attention.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, CircleCheck, CirclePause, Inbox, PenLine, Plus, Search, Settings2, Trash2, TriangleAlert, type LucideIcon } from "lucide-react";
import { useState } from "react";
import type { Health, Post } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { useControl } from "../lib/control.ts";
import { useAccounts } from "../lib/platforms.tsx";
import { navigate, newDraft, openPost, useRoute, type View } from "../lib/router.ts";
import { formatWhen, timeAgo } from "../lib/time.ts";
import { cx, firstLine, keys } from "../lib/util.ts";
import { Tip } from "./Tip.tsx";
import { toastError } from "./Toasts.tsx";

export function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="size-6 shrink-0" aria-hidden>
      <rect width="64" height="64" rx="16" className="fill-ink" />
      <rect x="16" y="15" width="32" height="8" rx="4" className="fill-canvas" />
      <rect x="16" y="28" width="24" height="8" rx="4" className="fill-canvas" opacity=".7" />
      <rect x="16" y="41" width="28" height="8" rx="4" className="fill-ai" />
    </svg>
  );
}

export const draftTitle = (p: Post) => p.title?.trim() || firstLine(p.thread.find((s) => s.text.trim())?.text ?? "", 60) || "Untitled draft";

const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Props {
  view: View;
  activePostId: string | null;
  health: Health;
  onOpenPalette: () => void;
  onNavigate?: () => void;
}

interface NavItem {
  label: string;
  icon: LucideIcon;
  to: string;
  active: boolean;
  count?: number;
  /** What the count means, on hover. */
  tip?: string;
  /** The count needs you: shown in the accent colour. */
  urgent?: boolean;
}

export function Sidebar(p: Props) {
  const { params } = useRoute();
  const { data: drafts, isPending } = useQuery({
    queryKey: ["posts", "draft"],
    queryFn: () => api.listPosts({ status: ["draft"], limit: 100 }),
  });
  const { data: scheduled } = useQuery({
    queryKey: ["posts", "scheduled"],
    queryFn: () => api.listPosts({ status: ["scheduled"], limit: 100 }),
  });
  const { data: attention } = useQuery({
    queryKey: ["posts", "attention"],
    queryFn: () => api.listPosts({ status: ["due", "failed"], limit: 50 }),
  });
  // shortcut: looks at the 100 latest published posts only; add a count endpoint if a week ever holds more.
  const { data: published } = useQuery({
    queryKey: ["posts", "published"],
    queryFn: () => api.listPosts({ status: ["published"], limit: 100 }),
  });
  const { data: accounts } = useAccounts();
  const { data: control } = useControl();
  const paused = control?.paused ?? null;
  const tz = p.health.timezone;
  const go = (fn: () => void) => () => {
    fn();
    p.onNavigate?.();
  };

  const waiting = control?.pendingApprovals ?? 0;
  const next = scheduled
    ?.map((s) => s.scheduledAt)
    .filter((at): at is string => !!at)
    .sort()[0];
  const now = Date.now();
  const lastWeek = published?.filter((s) => s.publishedAt && now - new Date(s.publishedAt).getTime() < WEEK).length ?? 0;
  const queueTab = params.get("tab") === "published" ? "published" : "upcoming";

  const nav: NavItem[] = [
    { label: "To review", icon: Inbox, to: "/", active: p.view === "inbox", count: waiting, urgent: true, tip: "Posts waiting for your approval" },
    {
      label: "Scheduled",
      icon: CalendarClock,
      to: "/queue",
      active: p.view === "queue" && queueTab === "upcoming",
      count: scheduled?.length,
      tip: next ? `Next ${formatWhen(next, tz)}` : undefined,
    },
    {
      label: "Published",
      icon: CircleCheck,
      to: "/queue?tab=published",
      active: p.view === "queue" && queueTab === "published",
      count: lastWeek,
      tip: "In the last 7 days",
    },
  ];
  const setup: NavItem[] = [
    { label: "Settings", icon: Settings2, to: "/settings", active: p.view === "settings" },
  ];

  // At most one line at the bottom, and only when something needs doing; the most serious wins.
  const alert = paused
    ? { tone: "red", icon: CirclePause, text: "Publishing paused", tip: paused.reason ?? undefined, to: "/" }
    : attention?.length
      ? { tone: "amber", icon: TriangleAlert, text: `${attention.length} post${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} you`, tip: "Due to post by hand, or failed", to: "/queue" }
      : accounts && !accounts.length && p.health.x.mode !== "api"
        ? { tone: "ai", icon: Plus, text: "Connect an account", tip: "Until then, you copy and post by hand", to: "/settings/accounts" }
        : null;

  const row = (n: NavItem) => (
    <button
      key={n.to}
      onClick={go(() => navigate(n.to))}
      aria-current={n.active ? "page" : undefined}
      className={cx(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
        n.active ? "bg-subtle font-medium text-ink" : "text-ink-2 hover:bg-subtle/70 hover:text-ink",
      )}
    >
      <n.icon size={16} className={n.active ? "text-ink" : "text-ink-3"} />
      <span className="flex-1 text-left">{n.label}</span>
      {!!n.count && (
        <Tip content={n.tip} side="right">
          <span
            className={cx(
              "min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-medium tabular-nums",
              n.urgent ? "bg-ai text-white" : "text-ink-3",
            )}
          >
            {n.count}
          </span>
        </Tip>
      )}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Logo />
        <span className="font-semibold tracking-tight">Yaypost</span>
        <div className="flex-1" />
        <Tip content={<>Search and commands <kbd className="opacity-60">{keys.palette}</kbd></>} side="bottom">
          <button
            onClick={p.onOpenPalette}
            aria-label="Search and commands"
            aria-keyshortcuts={keys.palette}
            className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-subtle hover:text-ink"
          >
            <Search size={16} />
          </button>
        </Tip>
      </div>

      <div className="px-3">
        <button
          onClick={go(() => newDraft())}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-ink text-sm font-medium text-canvas hover:opacity-90"
        >
          <PenLine size={15} /> New post
        </button>
      </div>

      <nav aria-label="Posts" className="mt-3 space-y-0.5 px-2">
        {nav.map(row)}
      </nav>

      {/* Drafts are the work in progress: listed directly, newest first, so picking one up is one click. */}
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        {!!drafts?.length && (
          <p className="flex items-center justify-between px-4 pb-1 text-xs text-ink-3">
            <span>Drafts</span>
            <span className="tabular-nums">{drafts.length}</span>
          </p>
        )}
        <ul id="drafts-list" aria-label="Drafts" className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
          {isPending && [0, 1, 2].map((i) => <li key={i} className="mx-2 my-2 h-8 animate-pulse rounded-md bg-subtle" />)}
          {drafts?.map((d) => (
            <DraftItem key={d.id} post={d} active={p.view === "compose" && p.activePostId === d.id} onOpen={go(() => openPost(d.id))} />
          ))}
        </ul>
      </div>

      {alert && (
        <div className="px-2 pb-1">
          <Tip content={alert.tip} side="right">
            <button
              onClick={go(() => navigate(alert.to))}
              className={cx(
                "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-medium",
                alert.tone === "red" && "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/50 dark:text-red-300",
                alert.tone === "amber" && "bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/50 dark:text-amber-300",
                alert.tone === "ai" && "bg-ai-soft text-ai hover:opacity-90",
              )}
            >
              <alert.icon size={15} /> {alert.text}
            </button>
          </Tip>
        </div>
      )}

      <nav aria-label="Setup" className="space-y-0.5 border-t border-line px-2 py-2">
        {setup.map(row)}
      </nav>
    </div>
  );
}
function DraftItem({ post, active, onOpen }: { post: Post; active: boolean; onOpen: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.deletePost(post.id),
    onSuccess: () => {
      qc.setQueryData<Post[]>(["posts", "draft"], (list) => list?.filter((p) => p.id !== post.id));
      if (active) newDraft();
    },
    onError: (e) => toastError("Couldn't delete the draft", e),
  });
  return (
    <li className="group relative">
      <button
        onClick={onOpen}
        className={cx(
          "block w-full rounded-lg py-2 pr-8 pl-2.5 text-left transition-colors",
          active ? "bg-subtle" : "hover:bg-subtle/70",
          remove.isPending && "opacity-40",
        )}
      >
        <span className={cx("block truncate text-sm", active ? "font-medium text-ink" : "text-ink-2")}>{draftTitle(post)}</span>
        <span className="block text-[11px] text-ink-3">
          {timeAgo(post.updatedAt)}
          {post.thread.length > 1 && ` · ${post.thread.length} posts`}
          {post.source !== "ui" && ` · via ${post.source}`}
        </span>
      </button>
      <button
        onClick={() => (confirm ? remove.mutate() : setConfirm(true))}
        onBlur={() => setConfirm(false)}
        aria-label={`Delete draft ${draftTitle(post)}`}
        className={cx(
          "absolute top-1/2 right-1.5 grid h-6 -translate-y-1/2 place-items-center rounded-md px-1 text-[11px] font-medium transition-opacity",
          confirm
            ? "bg-red-600 px-2 text-white opacity-100"
            : "text-ink-3 opacity-0 group-hover:opacity-100 hover:text-red-600 focus:opacity-100 [@media(hover:none)]:opacity-60",
        )}
      >
        {confirm ? "Delete" : <Trash2 size={13} />}
      </button>
    </li>
  );
}
