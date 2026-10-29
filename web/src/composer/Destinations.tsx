// Where this post goes: connected-account chips, then tabs for the shared thread and per-account versions.
import { Check, CircleAlert, GitFork, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Account, Post, Segment } from "../../../shared/types.ts";
import { Popover } from "../components/Popover.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { navigate } from "../lib/router.ts";
import { PlatformIcon, removedLabel, usePlatforms } from "../lib/platforms.tsx";
import { cx } from "../lib/util.ts";
import type { DraftTarget } from "./useDraft.ts";

interface Props {
  accounts: Account[];
  targets: DraftTarget[];
  /** The shared thread: a destination's snapshot of what it posted only gets its own tab when it differs. */
  shared: Segment[] | null;
  post: Post | null;
  readOnly: boolean;
  version: string | null;
  onToggle: (account: Account) => void;
  onVersion: (accountId: string | null) => void;
  onCustomize: (account: Account) => void;
  onReset: (account: Account) => void;
}

const sameText = (a: Segment[], b: Segment[]) =>
  JSON.stringify(a.map((s) => [s.text.trim(), s.mediaIds])) === JSON.stringify(b.map((s) => [s.text.trim(), s.mediaIds]));

/** Fade the edge(s) of a horizontal strip that has more to scroll to. */
function useOverflowCue() {
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const current = useRef(edges);
  const update = useCallback(() => {
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    if (current.current.left === left && current.current.right === right) return;
    current.current = { left, right };
    setEdges(current.current);
  }, [el]);
  // Content changes (tabs added, labels) don't resize the strip itself: re-measure after every render (no state
  // change unless an edge actually flips).
  useLayoutEffect(update);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [el, update]);
  const fade = 28;
  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${edges.left ? `transparent, black ${fade}px` : "black"}, ${edges.right ? `black calc(100% - ${fade}px), transparent` : "black"})`
      : undefined;
  return { ref, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined, more: edges.right };
}

export function Destinations(p: Props) {
  const platforms = usePlatforms();
  const [menu, setMenu] = useState(false);
  const selected = p.targets.map((t) => p.accounts.find((a) => a.id === t.accountId)).filter((a): a is Account => Boolean(a));
  const progress = (id: string) => p.post?.targets.find((t) => t.accountId === id);
  // Own versions, plus snapshots of what a destination posted when they differ from the shared thread now.
  const versions = p.targets.filter((t) => t.thread && (!t.snapshot || !p.shared || !sameText(t.thread, p.shared)));
  const plain = selected.filter((a) => !p.targets.find((t) => t.accountId === a.id)?.thread);
  const sharedCount = p.targets.filter((t) => !versions.includes(t)).length;
  const active = p.version ? p.accounts.find((a) => a.id === p.version) : undefined;
  const activeTarget = p.version ? p.targets.find((t) => t.accountId === p.version) : undefined;
  const activeProgress = p.version ? progress(p.version) : undefined;
  // Targets whose account was removed since (only published history keeps them).
  const removed = p.targets.filter((t) => !p.accounts.some((a) => a.id === t.accountId));
  const platformOf = (id: string) => progress(id)?.platform;
  const strip = useOverflowCue();

  return (
    <div className="mb-4 ml-10 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Destinations">
        {p.accounts.map((a) => {
          const on = p.targets.some((t) => t.accountId === a.id);
          const prog = progress(a.id);
          // A destination that already has posts live can't be dropped until it's finished (the server refuses too).
          const pinned = on && prog && prog.status !== "published" && prog.externalIds.length > 0;
          const locked = p.readOnly || pinned || (on && prog?.status === "published");
          return (
            <button
              key={a.id}
              aria-pressed={on}
              disabled={locked}
              onClick={() => p.onToggle(a)}
              title={
                pinned
                  ? `Part of this thread is live on ${platforms.name(a.platform)}; it stays a destination until it's finished`
                  : a.lastError
                    ? `${a.label}: ${a.lastError}`
                    : `${on ? "Don't post" : "Post"} to ${a.label}${a.handle ? ` (${a.handle})` : ""}`
              }
              className={cx(
                "flex h-7 max-w-[14rem] items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-xs transition-colors disabled:cursor-default",
                on ? "border-line-strong bg-surface font-medium text-ink shadow-sm" : "border-dashed border-line text-ink-3 enabled:hover:border-line-strong enabled:hover:text-ink-2",
              )}
            >
              <PlatformIcon platform={a.platform} size={12} tint={on} className={cx(!on && "opacity-60")} />
              <span className="truncate">{a.label}</span>
              {a.lastError ? <CircleAlert size={12} className="shrink-0 text-amber-600" /> : on && <Check size={12} className="shrink-0 text-ink-3" />}
            </button>
          );
        })}
        {removed.map((t) => {
          const platform = platformOf(t.accountId);
          if (!platform) return null;
          return (
            <span
              key={t.accountId}
              title={`This account was removed after the post went out; the post history stays.`}
              className="flex h-7 max-w-[16rem] items-center gap-1.5 rounded-full border border-line pr-2.5 pl-2 text-xs text-ink-3"
            >
              <PlatformIcon platform={platform} size={12} tint={false} className="opacity-60" />
              <span className="truncate">{removedLabel(platforms, platform)}</span>
            </span>
          );
        })}
        {!p.targets.length && (
          <span className="text-xs text-ink-3">
            None selected · pick at least one to schedule or publish
          </span>
        )}
        {!p.readOnly && p.accounts.length === 0 && (
          <button onClick={() => navigate("/settings/accounts")} className="text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline">
            Connect accounts
          </button>
        )}
      </div>

      {p.targets.length > 0 && (versions.length > 0 || (!p.readOnly && selected.length > 0)) && (
        <div ref={strip.ref} style={strip.style} className="flex items-center gap-1 overflow-x-auto [scrollbar-width:thin]">
          {versions.length > 0 && (
          <Tabs
            label="Versions"
            size="sm"
            className="shrink-0"
            // "" is the shared thread.
            value={p.version ?? ""}
            onChange={(v) => p.onVersion(v || null)}
            tabs={[
              {
                value: "",
                label: (
                  <>
                    Shared
                    <span className="font-normal text-ink-3" title={`Goes to ${sharedCount} account${sharedCount === 1 ? "" : "s"}`}>
                      · {sharedCount}
                    </span>
                  </>
                ),
              },
              ...versions.flatMap((t) => {
                const a = p.accounts.find((x) => x.id === t.accountId);
                const platform = a?.platform ?? platformOf(t.accountId);
                if (!platform) return [];
                const name = a?.label ?? removedLabel(platforms, platform);
                return {
                  value: t.accountId,
                  title: t.snapshot ? `What was posted to ${name} (the shared thread changed since)` : `${name}'s own version`,
                  label: (
                    <>
                      <PlatformIcon platform={platform} size={12} tint={p.version === t.accountId} />
                      {name}
                      {t.snapshot && <span className="font-normal text-ink-3">· as posted</span>}
                    </>
                  ),
                };
              }),
            ]}
          />
          )}
          {!p.readOnly && plain.length > 0 && (
            <div className="relative shrink-0">
              {plain.length === 1 ? (
                <button onClick={() => p.onCustomize(plain[0]!)} className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-ink-3 hover:bg-subtle hover:text-ink">
                  <GitFork size={13} /> Customize for {plain[0]!.label}
                </button>
              ) : (
                <>
                  <Popover
                    trigger={
                      <button className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-ink-3 hover:bg-subtle hover:text-ink">
                        <GitFork size={13} /> Customize for…
                      </button>
                    }
                    open={menu}
                    onOpenChange={setMenu}
                    className="w-60 p-1"
                  >
                    {plain.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => {
                          setMenu(false);
                          p.onCustomize(a);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-subtle"
                      >
                        <PlatformIcon platform={a.platform} size={14} />
                        <span className="truncate">Customize for {a.label}</span>
                      </button>
                    ))}
                  </Popover>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {active && !activeTarget?.snapshot && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          {!p.readOnly && activeProgress?.status !== "published" && (
            <span className="flex items-center gap-1">
              <button
                onClick={() => p.onReset(active)}
                disabled={Boolean(activeProgress?.externalIds.length)}
                title={activeProgress?.externalIds.length ? "Part of this version is already live" : "Drop this version; the account gets the shared thread"}
                className="flex h-7 items-center gap-1 rounded-md px-1.5 hover:bg-subtle hover:text-ink disabled:opacity-40"
              >
                <RotateCcw size={12} /> Reset to shared
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
