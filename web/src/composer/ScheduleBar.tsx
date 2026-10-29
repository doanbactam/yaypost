// Composer footer: add to queue (showing the real next slot), pick a time, publish now, copy.
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Copy, LoaderCircle, RotateCcw, Send } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Health, Post } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { Popover } from "../components/Popover.tsx";
import { Tip } from "../components/Tip.tsx";
import { navigate } from "../lib/router.ts";
import { formatWhen, fromZonedInput, toZonedInput } from "../lib/time.ts";
import { cx, keys } from "../lib/util.ts";

export type Busy = "queue" | "publish" | "unschedule" | null;

interface Props {
  health: Health;
  post: Post | null;
  empty: boolean;
  /** Connected accounts this post goes to; "Publish now" needs at least one. */
  destinations: number;
  slotTarget: string | null;
  pickerOpen: boolean;
  busy: Busy;
  setPickerOpen: (open: boolean) => void;
  onQueue: () => void;
  onSchedule: (iso: string) => void;
  onUnschedule: () => void;
  onPublish: () => void;
  onCopy: () => void;
  /** A failed post with destinations: Retry (resume the failed ones) replaces Publish now / Add to queue. */
  retry?: { published: number; total: number; pending: boolean; run: () => void };
}

const ghostBase = "flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap disabled:opacity-40";
const ghost = cx(ghostBase, "text-ink-2 hover:bg-subtle hover:text-ink");

export function ScheduleBar(p: Props) {
  const tz = p.health.timezone;
  const { data: slots } = useQuery({ queryKey: ["slots"], queryFn: () => api.nextSlots(5), refetchInterval: 60_000 });
  const next = p.slotTarget ?? slots?.[0] ?? null;
  const scheduled = p.post?.status === "scheduled" && p.post.scheduledAt;
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [publishHelp, setPublishHelp] = useState(false);

  useEffect(() => {
    if (!confirmPublish) return;
    const t = setTimeout(() => setConfirmPublish(false), 4000);
    return () => clearTimeout(t);
  }, [confirmPublish]);

  const { setPickerOpen } = p;
  const closePicker = useCallback(() => setPickerOpen(false), [setPickerOpen]);

  return (
    <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap sm:gap-1.5">
      <Tip content={<>Copy thread <kbd className="opacity-60">{keys.copy}</kbd></>}>
        <button onClick={p.onCopy} disabled={p.empty} className={ghost} aria-label="Copy thread">
          <Copy size={16} />
          <span className="max-sm:hidden">Copy</span>
        </button>
      </Tip>

      <div className="flex-1" />

      <Popover
        trigger={
          <button disabled={p.empty} className={ghost} aria-label="Schedule for a specific time">
            <CalendarClock size={15} />
            <span className="max-sm:hidden">{scheduled ? "Change time" : "Pick time"}</span>
          </button>
        }
        open={p.pickerOpen}
        onOpenChange={(open) => (open ? p.setPickerOpen(true) : closePicker())}
        side="top"
        align="end"
      >
        <TimePicker tz={tz} initial={p.post?.scheduledAt ?? next} slots={slots ?? []} onPick={p.onSchedule} busy={p.busy === "queue"} />
      </Popover>

      {p.retry ? (
        <div className="flex items-center gap-2 max-sm:order-last max-sm:w-full max-sm:flex-col max-sm:items-stretch">
          {!!p.retry.published && (
            <span className="text-xs text-ink-3 tabular-nums">
              {p.retry.published}/{p.retry.total} live
            </span>
          )}
          <button
            onClick={p.retry.run}
            disabled={p.retry.pending}
            className="flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-ink px-3.5 text-sm font-medium whitespace-nowrap text-canvas shadow-sm hover:opacity-90 disabled:opacity-40 max-sm:h-11"
          >
            {p.retry.pending ? <LoaderCircle size={15} className="animate-spin" /> : <RotateCcw size={15} />}
            {p.retry.published ? "Retry the failed ones" : "Retry"}
          </button>
        </div>
      ) : !p.destinations ? (
        // Nowhere to publish yet: a tap (touch has no hover) says why and how to fix it, instead of a dead button.
        <Popover
          trigger={
            <button aria-disabled className={cx(ghost, "opacity-40 hover:opacity-70")} aria-label="Publish now (unavailable)">
              <Send size={15} />
              <span className="max-sm:hidden">Publish now</span>
            </button>
          }
          open={publishHelp}
          onOpenChange={setPublishHelp}
          side="top"
          align="end"
          className="w-72"
        >
          <p className="text-sm font-medium">Nowhere to publish yet</p>
          <p className="mt-1 text-xs text-ink-3">Publishing goes through a connected account. Choose one under Destinations, or connect one first.</p>
          <button
            onClick={() => navigate("/settings/accounts")}
            className="mt-3 flex h-8 w-full items-center justify-center rounded-lg bg-ink text-sm font-medium text-canvas hover:opacity-90"
          >
            Connect an account
          </button>
        </Popover>
      ) : (
        <span className="inline-flex">
          <button
            onClick={() => (confirmPublish ? (setConfirmPublish(false), p.onPublish()) : setConfirmPublish(true))}
            disabled={p.empty || p.busy === "publish"}
            aria-label={confirmPublish ? "Confirm publish" : "Publish now"}
            className={
              confirmPublish
                ? cx(ghostBase, "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900")
                : ghost
            }
          >
            {p.busy === "publish" ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}
            {/* Both labels share one grid cell so the button keeps its width (a second click must land on it). */}
            <span className={cx("grid", !confirmPublish && "max-sm:hidden")}>
              <span className="invisible col-start-1 row-start-1 max-sm:hidden" aria-hidden>
                Publish now
              </span>
              <span className="col-start-1 row-start-1 text-center">{confirmPublish ? "Confirm?" : "Publish now"}</span>
            </span>
          </button>
        </span>
      )}

      {p.retry ? null : scheduled ? (
        <div className="flex h-9 shrink-0 items-center gap-1 rounded-lg bg-sky-50 pr-1 pl-3 text-sm whitespace-nowrap text-sky-800 max-sm:order-last max-sm:h-11 max-sm:w-full max-sm:justify-between dark:bg-sky-950/60 dark:text-sky-200">
          <span className="font-medium">{formatWhen(p.post!.scheduledAt!, tz)}</span>
          <button
            onClick={p.onUnschedule}
            disabled={p.busy === "unschedule"}
            className="rounded-md px-2 py-1 text-xs hover:bg-sky-100 dark:hover:bg-sky-900"
          >
            Unschedule
          </button>
        </div>
      ) : (
        <button
          onClick={p.onQueue}
          aria-keyshortcuts={keys.queue}
          disabled={p.empty || p.busy === "queue"}
          className="flex h-9 min-w-0 items-center gap-2 rounded-lg bg-ink pr-2 pl-3.5 text-sm font-medium whitespace-nowrap text-canvas shadow-sm transition-opacity hover:opacity-90 disabled:opacity-40 max-sm:order-last max-sm:h-11 max-sm:w-full max-sm:justify-center"
        >
          {p.busy === "queue" && <LoaderCircle size={15} className="animate-spin" />}
          <span>{p.slotTarget ? "Schedule" : "Add to queue"}</span>
          {next && <span className="min-w-0 truncate font-normal opacity-60">{formatWhen(next, tz)}</span>}
        </button>
      )}
    </div>
  );
}

function TimePicker(p: { tz: string; initial: string | null; slots: string[]; busy: boolean; onPick: (iso: string) => void }) {
  const [value, setValue] = useState(() => toZonedInput(p.initial ?? new Date(Date.now() + 3600_000).toISOString(), p.tz));
  const iso = value ? fromZonedInput(value, p.tz) : null;
  const past = iso ? new Date(iso).getTime() < Date.now() : true;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (iso && !past) p.onPick(iso);
      }}
      className="space-y-3"
    >
      <label className="block">
        <span className="text-xs font-medium text-ink-2">Post at</span>
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mt-1 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm focus:border-line-strong"
        />
        <span className="mt-1 block text-xs text-ink-3">Times are in {p.tz.replace(/_/g, " ")}</span>
      </label>
      {p.slots.length > 0 && (
        <div>
          <span className="text-xs font-medium text-ink-2">Free slots</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {p.slots.map((s) => (
              <button
                type="button"
                key={s}
                onClick={() => setValue(toZonedInput(s, p.tz))}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-xs",
                  toZonedInput(s, p.tz) === value ? "border-ink bg-ink text-canvas" : "border-line text-ink-2 hover:border-line-strong",
                )}
              >
                {formatWhen(s, p.tz)}
              </button>
            ))}
          </div>
        </div>
      )}
      <button
        type="submit"
        disabled={past || p.busy}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-ink text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-40"
      >
        {p.busy && <LoaderCircle size={15} className="animate-spin" />}
        {past ? "Pick a time in the future" : `Schedule for ${iso ? formatWhen(iso, p.tz) : ""}`}
      </button>
    </form>
  );
}
