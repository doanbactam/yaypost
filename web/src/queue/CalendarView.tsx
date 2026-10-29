// Month, week and day views of the queue. Posts are chips coloured by state; published ones fill the past, free slots the
// future. Scheduled posts drag to another day, a free slot or any time on the week/day grid to reschedule.
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type CollisionDetection,
  type Over,
} from "@dnd-kit/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, PenLine, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Post, QueueItem } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { ApprovalPill } from "../components/Approval.tsx";
import { TargetIcons } from "../components/TargetStatus.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { PlatformIcon } from "../lib/platforms.tsx";
import { newDraft, openPost } from "../lib/router.ts";
import { addDays, dayKey, formatDate, formatTime, formatWhen, fromZonedInput, toZonedInput } from "../lib/time.ts";
import { cx, firstLine } from "../lib/util.ts";

export type CalendarMode = "month" | "week" | "day";

/** The queue API serves at most 90 days ahead; the calendar can't page past that. The past is published posts only. */
const RANGE = 90;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Time grid: pixels per hour, and how long a post reads as on it (a post is an instant; this is just its block). */
const HOUR = 64;
const BLOCK = 30;
const SNAP = 15;

const utc = (key: string) => new Date(`${key}T12:00:00Z`);
const fmt = (key: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...o }).format(utc(key));
/** Monday on or before a YYYY-MM-DD key. */
const weekStart = (key: string) => addDays(key, -((utc(key).getUTCDay() + 6) % 7));
const monthStart = (key: string) => `${key.slice(0, 8)}01`;
const addMonths = (key: string, n: number) => {
  const d = utc(monthStart(key));
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
/** Every day of the weeks that cover `key`'s month. */
const monthDays = (key: string) => {
  const first = weekStart(monthStart(key));
  const end = addDays(addMonths(key, 1), -1);
  const out: string[] = [];
  for (let d = first; d <= end || out.length % 7; d = addDays(d, 1)) out.push(d);
  return out;
};
const minutesOf = (iso: string, tz: string) => {
  const t = toZonedInput(iso, tz).slice(11);
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
};
const atMinutes = (key: string, m: number, tz: string) =>
  fromZonedInput(`${key}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`, tz);
const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", hour: "numeric" }).format(Date.UTC(2000, 0, 1, h));

type Posted = Extract<QueueItem, { type: "post" }>;

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** `published`: the same calendar as a read-only record of what went out (no slots, nothing to move, nothing after today). */
export function CalendarView(p: { mode: CalendarMode; tz: string; onMode: (m: CalendarMode) => void; published?: boolean }) {
  const { mode, tz, onMode } = p;
  const qc = useQueryClient();
  const now = useNow();
  const today = dayKey(new Date(now), tz);
  const last = p.published ? today : addDays(today, RANGE - 1);
  const { data: queue, isPending, error } = useQuery({ queryKey: ["queue", RANGE], queryFn: () => api.queue(RANGE), refetchInterval: 60_000 });
  // Same cache as the Published tab: the past of the calendar.
  const { data: published } = useQuery({ queryKey: ["posts", "published"], queryFn: () => api.listPosts({ status: ["published"], limit: 100 }) });
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<Posted | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // On touch a short hold starts a drag, so swiping still scrolls.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    // Space picks a chip up; Enter stays a click (open / pick).
    useSensor(KeyboardSensor, { keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] } }),
  );

  const byDay = useMemo(() => {
    const map = new Map<string, QueueItem[]>();
    const seen = new Set<string>();
    for (const d of queue?.days ?? []) {
      const items = p.published ? d.items.filter((i) => i.type === "post" && i.post.status === "published") : d.items;
      map.set(d.date, [...items]);
      for (const i of items) if (i.type === "post") seen.add(i.post.id);
    }
    for (const post of published ?? []) {
      if (!post.publishedAt || seen.has(post.id)) continue;
      const key = dayKey(post.publishedAt, tz);
      map.set(key, [...(map.get(key) ?? []), { type: "post" as const, at: post.publishedAt, post }].sort((a, b) => a.at.localeCompare(b.at)));
    }
    return map;
  }, [queue, published, tz, p.published]);

  const days = mode === "month" ? monthDays(anchor) : mode === "week" ? Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i)) : [anchor];
  const step = (n: number) => setAnchor(mode === "month" ? addMonths(anchor, n) : addDays(anchor, n * (mode === "week" ? 7 : 1)));
  const nextStart = mode === "month" ? addMonths(anchor, 1) : addDays(days.at(-1)!, 1);
  const label =
    mode === "month"
      ? fmt(anchor, { month: "long", year: "numeric" })
      : mode === "week"
        ? `${fmt(days[0]!, { month: "short", day: "numeric" })} – ${fmt(days[6]!, { month: "short", day: "numeric", year: "numeric" })}`
        : fmt(anchor, { weekday: "long", month: "long", day: "numeric" });

  // The grid spans working hours, stretched to whatever is on it.
  const hours = useMemo(() => {
    const mins = days.flatMap((d) => byDay.get(d) ?? []).map((i) => minutesOf(i.at, tz));
    return { from: Math.min(8, ...mins.map((m) => Math.floor(m / 60))), to: Math.min(24, Math.max(20, ...mins.map((m) => Math.ceil((m + BLOCK) / 60)))) };
  }, [days.join(), byDay, tz]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = useMutation({
    mutationFn: ({ post, at }: { post: Post; at: string; from: string }) => api.schedule(post.id, at),
    onSuccess: (saved, { post, from }) => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["posts"] });
      toast({
        title: `Moved to ${formatWhen(saved.scheduledAt!, tz)}`,
        tone: "success",
        actions:
          Date.parse(from) > Date.now()
            ? [{ label: "Undo", onClick: () => move.mutate({ post, at: from, from: saved.scheduledAt! }) }]
            : undefined,
      });
    },
    onError: (e) => toastError("Couldn't move the post", e),
  });

  /** Where a drop lands: a slot's time; on the grid, where the chip's top edge is; a month day keeps the time of day or takes that day's first free slot. */
  function target(a: Active, over: Over | null): string | null {
    const item = a.data.current as Posted | undefined;
    const id = over ? String(over.id) : "";
    if (!item || !over) return null;
    if (id.startsWith("slot:")) return id.slice(5);
    const key = id.slice(id.indexOf(":") + 1);
    if (id.startsWith("col:")) {
      const top = a.rect.current.translated?.top;
      if (top == null) return null;
      const m = hours.from * 60 + Math.round(((top - over.rect.top) / HOUR) * (60 / SNAP)) * SNAP;
      return atMinutes(key, Math.min(Math.max(m, 0), 24 * 60 - SNAP), tz);
    }
    if (key === dayKey(item.at, tz)) return null;
    const keep = fromZonedInput(`${key}T${toZonedInput(item.at, tz).slice(11)}`, tz);
    if (Date.parse(keep) > Date.now()) return keep;
    return byDay.get(key)?.find((i) => i.type === "slot" && Date.parse(i.at) > Date.now())?.at ?? keep;
  }

  if (error) return <p className="py-10 text-center text-sm text-red-600">Couldn't load the queue: {error.message}</p>;

  const ctx: Ctx = { tz, today, last, now, byDay, readOnly: !!p.published, onDay: (d) => (setAnchor(d), onMode("day")) };
  const dayItems = (byDay.get(anchor) ?? []).filter((i): i is Posted => i.type === "post");
  const picked = dayItems.find((i) => i.post.id === selected) ?? dayItems[0];

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collide}
      onDragStart={(e) => setActive((e.active.data.current as Posted | undefined) ?? null)}
      onDragMove={(e) => setHover(target(e.active, e.over))}
      onDragOver={(e) => setHover(target(e.active, e.over))}
      accessibility={{
        announcements: {
          onDragStart: ({ active: a }) => `Picked up the ${formatWhen((a.data.current as Posted).at, tz)} post`,
          onDragOver: ({ active: a, over }) => {
            const at = target(a, over);
            return at ? `Over ${formatWhen(at, tz)}` : undefined;
          },
          onDragEnd: ({ active: a, over }) => {
            const at = target(a, over);
            return at ? `Dropped at ${formatWhen(at, tz)}` : "Not moved";
          },
          onDragCancel: () => "Not moved",
        },
      }}
      onDragCancel={() => (setActive(null), setHover(null))}
      onDragEnd={(e) => {
        const item = e.active.data.current as Posted | undefined;
        const at = target(e.active, e.over);
        setActive(null);
        setHover(null);
        if (!item || !at || at === item.at || (!e.delta.x && !e.delta.y)) return;
        if (Date.parse(at) <= Date.now()) return void toast({ title: `${formatWhen(at, tz)} has already passed`, tone: "error" });
        move.mutate({ post: item.post, at, from: item.at });
      }}
    >
      <div className="mb-3 flex items-center gap-3">
        {/* Today as a date badge: where you are, and the way back to it. */}
        <Tip content="Today">
          <button
            onClick={() => setAnchor(today)}
            aria-label="Go to today"
            className="flex w-11 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface text-center shadow-xs hover:border-line-strong"
          >
            <span className="bg-subtle py-px text-[10px] font-semibold tracking-wide text-ink-3 uppercase">{fmt(today, { month: "short" })}</span>
            <span className="py-0.5 text-base leading-tight font-semibold text-ai tabular-nums">{Number(today.slice(8))}</span>
          </button>
        </Tip>
        <h2 className="mr-auto text-base font-semibold" aria-live="polite">
          {label}
        </h2>
        <div className="flex items-center rounded-lg border border-line bg-surface shadow-xs">
          <button onClick={() => step(-1)} aria-label="Previous" className="grid size-8 place-items-center rounded-l-lg text-ink-2 hover:bg-subtle hover:text-ink">
            <ChevronLeft size={16} />
          </button>
          <span aria-hidden className="h-4 w-px bg-line" />
          <button
            onClick={() => step(1)}
            disabled={nextStart > last}
            aria-label="Next"
            className="grid size-8 place-items-center rounded-r-lg text-ink-2 hover:bg-subtle hover:text-ink disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className={cx(isPending && "animate-pulse")} aria-busy={isPending}>
        {mode === "month" ? (
          <MonthGrid days={days} month={anchor.slice(0, 7)} ctx={ctx} />
        ) : mode === "week" ? (
          <TimeGrid days={days} hours={hours} ctx={ctx} dragging={!!active} />
        ) : (
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <div className="min-w-0 flex-1">
              <TimeGrid days={days} hours={hours} ctx={ctx} dragging={!!active} picked={picked?.post.id} onPick={setSelected} />
            </div>
            <aside className="flex flex-col gap-4 lg:sticky lg:top-4 lg:w-72">
              <MiniMonth anchor={anchor} ctx={ctx} onPick={setAnchor} />
              {picked && <Details item={picked} tz={tz} />}
            </aside>
          </div>
        )}
      </div>

      {/* The dragged chip floats above every column, and shows the time it would land on. */}
      <DragOverlay dropAnimation={null}>
        {active && <Face item={active} tz={tz} at={hover ?? active.at} className="h-full shadow-lg ring-1 ring-ai" />}
      </DragOverlay>
    </DndContext>
  );
}

interface Ctx {
  tz: string;
  today: string;
  last: string;
  now: number;
  byDay: Map<string, QueueItem[]>;
  readOnly: boolean;
  onDay: (key: string) => void;
}

/** The pointer picks the target, and a slot inside a day wins over the day. Keyboard drags fall back to rectangles. */
const collide: CollisionDetection = (args) => {
  const hits = args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
  const slots = hits.filter((h) => String(h.id).startsWith("slot:"));
  return slots.length ? slots : hits;
};

function DayNumber({ date, ctx, dim }: { date: string; ctx: Ctx; dim?: boolean }) {
  return (
    <Tip content={formatDate(date, true)}>
      <button
        onClick={() => ctx.onDay(date)}
        disabled={date > ctx.last}
        aria-label={`Open ${formatDate(date, true)}`}
        className={cx(
          "grid size-6 place-items-center rounded-full text-xs tabular-nums transition-colors disabled:pointer-events-none",
          date === ctx.today ? "bg-ai font-semibold text-white" : dim ? "text-ink-3/60 hover:bg-subtle" : "text-ink-2 hover:bg-subtle hover:text-ink",
        )}
      >
        {Number(date.slice(8))}
      </button>
    </Tip>
  );
}

function MonthGrid({ days, month, ctx }: { days: string[]; month: string; ctx: Ctx }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <div className="grid grid-cols-7 border-b border-line bg-subtle/50 text-[11px] font-medium text-ink-3">
        {WEEKDAYS.map((d) => (
          <span key={d} className="px-2 py-1.5">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 [&>*:nth-child(7n)]:border-r-0">
        {days.map((key) => (
          <MonthCell key={key} date={key} ctx={ctx} outside={!key.startsWith(month)} />
        ))}
      </div>
    </div>
  );
}

function MonthCell({ date, ctx, outside }: { date: string; ctx: Ctx; outside: boolean }) {
  const past = date < ctx.today;
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}`, disabled: past || date > ctx.last });
  const items = ctx.byDay.get(date) ?? [];
  const posts = items.filter((i): i is Posted => i.type === "post");
  const slot = items.find((i) => i.type === "slot" && Date.parse(i.at) > ctx.now);
  const limit = 3;
  return (
    <div
      ref={setNodeRef}
      className={cx(
        "group/day flex min-h-28 min-w-0 flex-col gap-1 border-r border-b border-line p-1.5 transition-colors",
        (outside || past) && "bg-subtle/40",
        isOver && "bg-ai-soft",
      )}
    >
      <div className="flex items-center gap-1">
        <DayNumber date={date} ctx={ctx} dim={outside} />
        {date.endsWith("-01") && <span className="text-[11px] font-medium text-ink-2">{fmt(date, { month: "short" })}</span>}
        {/* The day's first free slot is one click away, without listing every slot. */}
        {slot && (
          <Tip content={`Write for ${formatTime(slot.at, ctx.tz)}`}>
            <button
              onClick={() => newDraft(slot.at)}
              aria-label={`Write for ${formatWhen(slot.at, ctx.tz)}`}
              className="ml-auto grid size-6 place-items-center rounded-md text-ink-3 opacity-0 group-hover/day:opacity-100 hover:bg-subtle hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-60"
            >
              <Plus size={13} />
            </button>
          </Tip>
        )}
      </div>
      {posts.slice(0, limit).map((i) => (
        <Chip key={i.post.id} item={i} ctx={ctx} />
      ))}
      {posts.length > limit && (
        <button onClick={() => ctx.onDay(date)} aria-label={`${posts.length - limit} more on ${formatDate(date)}`} className="px-1 text-left text-[11px] font-medium text-ink-3 hover:text-ink">
          +{posts.length - limit}
        </button>
      )}
    </div>
  );
}

function TimeGrid(p: {
  days: string[];
  hours: { from: number; to: number };
  ctx: Ctx;
  dragging: boolean;
  picked?: string;
  onPick?: (id: string) => void;
}) {
  const span = p.hours.to - p.hours.from;
  const single = p.days.length === 1;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      {!single && (
        <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line bg-subtle/50">
          <span />
          {p.days.map((d) => (
            <span key={d} className="flex items-center gap-1.5 border-l border-line px-2 py-1.5 text-[11px] font-medium text-ink-3">
              {fmt(d, { weekday: "short" })}
              <DayNumber date={d} ctx={p.ctx} />
            </span>
          ))}
        </div>
      )}
      <div className={cx("grid", single ? "grid-cols-[3.5rem_minmax(0,1fr)]" : "grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]")}>
        <div className="relative" style={{ height: span * HOUR }}>
          {Array.from({ length: span }, (_, i) => (
            <span key={i} className="absolute right-2 -translate-y-1/2 text-[10px] text-ink-3 tabular-nums first:hidden" style={{ top: i * HOUR }}>
              {hourLabel(p.hours.from + i)}
            </span>
          ))}
        </div>
        {p.days.map((d) => (
          <Column key={d} date={d} {...p} span={span} />
        ))}
      </div>
    </div>
  );
}

/** Side-by-side lanes for blocks that overlap in time. */
function lay<T extends { at: string }>(items: T[], tz: string) {
  const out: { item: T; start: number; lane: number; of: number }[] = [];
  let group: typeof out = [];
  let lanes: number[] = [];
  let end = -1;
  const close = () => group.forEach((g) => (g.of = lanes.length));
  for (const item of items) {
    const start = minutesOf(item.at, tz);
    if (start >= end) (close(), (group = []), (lanes = []));
    let lane = lanes.findIndex((e) => e <= start);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = start + BLOCK;
    end = Math.max(end, start + BLOCK);
    const g = { item, start, lane, of: 1 };
    group.push(g);
    out.push(g);
  }
  close();
  return out;
}

function Column(p: {
  date: string;
  hours: { from: number; to: number };
  span: number;
  ctx: Ctx;
  dragging: boolean;
  picked?: string;
  onPick?: (id: string) => void;
}) {
  const { ctx, date } = p;
  const past = date < ctx.today;
  const { setNodeRef, isOver } = useDroppable({ id: `col:${date}`, disabled: past || date > ctx.last });
  const [ghost, setGhost] = useState<number | null>(null);
  const items = (ctx.byDay.get(date) ?? []).filter((i) => i.type === "post" || Date.parse(i.at) > ctx.now);
  const y = (m: number) => ((m - p.hours.from * 60) / 60) * HOUR;
  const nowM = date === ctx.today ? minutesOf(new Date(ctx.now).toISOString(), ctx.tz) : null;
  const ghostAt = ghost != null ? atMinutes(date, ghost, ctx.tz) : null;
  /** The future half hour under the pointer, or null. */
  const slotAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const m = p.hours.from * 60 + Math.floor(((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 2) * 30;
    return m < 24 * 60 && Date.parse(atMinutes(date, m, ctx.tz)) > ctx.now ? m : null;
  };
  return (
    <div
      ref={setNodeRef}
      onMouseMove={(e) => {
        // Empty time is a place to write: a ghost block follows the pointer on future times.
        if (ctx.readOnly || p.dragging || e.target !== e.currentTarget) return setGhost(null);
        setGhost(slotAt(e));
      }}
      onMouseLeave={() => setGhost(null)}
      onClick={(e) => {
        if (ctx.readOnly || e.target !== e.currentTarget) return;
        const m = slotAt(e);
        setGhost(null);
        if (m != null) newDraft(atMinutes(date, m, ctx.tz));
      }}
      className={cx(
        "relative border-l border-line transition-colors",
        past && "bg-subtle/40",
        isOver && "bg-ai-soft/50",
        ghost != null && "cursor-pointer",
      )}
      style={{ height: p.span * HOUR }}
    >
      {Array.from({ length: p.span }, (_, i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-line first:border-0" style={{ top: i * HOUR }} />
      ))}
      {ghostAt && ghost != null && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 flex items-center gap-1 rounded-md border border-dashed border-ink-3 px-1.5 text-[11px] text-ink-2"
          style={{ top: y(ghost), height: (BLOCK / 60) * HOUR - 2 }}
        >
          <Plus size={11} /> {formatTime(ghostAt, ctx.tz)}
        </span>
      )}
      {lay([...items].sort((a, b) => minutesOf(a.at, ctx.tz) - minutesOf(b.at, ctx.tz)), ctx.tz).map(({ item, start, lane, of }) => (
        <div
          key={item.type === "post" ? item.post.id : item.at}
          className="absolute px-0.5 *:h-full"
          style={{ top: y(start) + 1, height: (BLOCK / 60) * HOUR - 2, left: `${(lane / of) * 100}%`, width: `${100 / of}%` }}
        >
          {item.type === "post" ? (
            <Chip item={item} ctx={ctx} picked={p.picked === item.post.id} onPick={p.onPick} />
          ) : (
            <Slot at={item.at} tz={ctx.tz} />
          )}
        </div>
      ))}
      {nowM != null && nowM >= p.hours.from * 60 && nowM <= p.hours.to * 60 && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-red-500" style={{ top: y(nowM) }}>
          <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-red-500" />
        </span>
      )}
    </div>
  );
}

/** Left bar colour = the state that matters to you: waiting on your approval, needs you, failed, live, or just queued. */
function tone(post: Post): string {
  if (post.approval?.state === "pending") return "border-ai bg-ai-soft";
  if (post.status === "due") return "border-amber-500 bg-amber-50 dark:bg-amber-950/40";
  if (post.status === "failed") return "border-red-500 bg-red-50 dark:bg-red-950/40";
  if (post.status === "published") return "border-emerald-500 bg-emerald-50/60 text-ink-2 dark:bg-emerald-950/30";
  return "border-ink bg-canvas";
}

/** Chips open the post; in the day view they pick it for the side panel instead. */
function Chip({ item, ctx, picked, onPick }: { item: Posted; ctx: Ctx; picked?: boolean; onPick?: (id: string) => void }) {
  const { post } = item;
  const movable = post.status === "scheduled";
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: post.id, data: item, disabled: !movable });
  const body = (
    <button
      ref={setNodeRef}
      {...listeners}
      {...(movable ? attributes : {})}
      onClick={() => (onPick ? onPick(post.id) : openPost(post.id))}
      aria-pressed={onPick ? picked : undefined}
      className={cx(
        "block w-full min-w-0 rounded-md text-left",
        movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        isDragging && "opacity-40",
        picked && "ring-2 ring-ai",
      )}
    >
      <Face item={item} tz={ctx.tz} className="h-full hover:brightness-95" />
    </button>
  );
  if (onPick) return body;
  return <Tip content={<span className="line-clamp-4 whitespace-pre-wrap">{post.thread[0]?.text.trim() || "Empty post"}</span>}>{body}</Tip>;
}

function Face({ item, tz, at, className }: { item: Posted; tz: string; at?: string; className?: string }) {
  const { post } = item;
  const text = firstLine(post.thread.find((s) => s.text.trim())?.text ?? "", 80) || "Empty post";
  return (
    <span
      className={cx(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md border-l-2 px-1.5 py-1 text-[11px] leading-tight shadow-xs",
        tone(post),
        className,
      )}
    >
      <PlatformIcon platform={post.targets[0]?.platform ?? "x"} size={11} />
      <span className="shrink-0 font-medium tabular-nums">{formatTime(at ?? item.at, tz)}</span>
      <span className="min-w-0 truncate text-ink-2">{text}</span>
    </span>
  );
}

function Slot({ at, tz }: { at: string; tz: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${at}` });
  return (
    <button
      ref={setNodeRef}
      onClick={() => newDraft(at)}
      aria-label={`Write for ${formatWhen(at, tz)}`}
      className={cx(
        "group/slot flex size-full items-center gap-1 rounded-md border border-dashed px-1.5 text-[11px] tabular-nums transition-colors",
        isOver ? "border-ai bg-ai-soft text-ai" : "border-line-strong bg-surface text-ink-3 hover:border-ink-3 hover:text-ink",
      )}
    >
      {formatTime(at, tz)}
      <Plus size={11} className="ml-auto opacity-0 group-hover/slot:opacity-100 [@media(hover:none)]:opacity-60" />
    </button>
  );
}

/** Small month to jump between days; a dot marks days with posts. */
function MiniMonth({ anchor, ctx, onPick }: { anchor: string; ctx: Ctx; onPick: (key: string) => void }) {
  const [month, setMonth] = useState(monthStart(anchor));
  const [prevAnchor, setPrevAnchor] = useState(anchor);
  if (prevAnchor !== anchor) {
    setPrevAnchor(anchor);
    setMonth(monthStart(anchor));
  }
  const nav = (n: number, label: string, icon: ReactNode) => (
    <button
      onClick={() => setMonth(addMonths(month, n))}
      disabled={n > 0 && addMonths(month, 1) > ctx.last}
      aria-label={label}
      className="grid size-7 place-items-center rounded-md text-ink-2 hover:bg-subtle hover:text-ink disabled:opacity-30"
    >
      {icon}
    </button>
  );
  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-xs">
      <div className="mb-1 flex items-center">
        {nav(-1, "Previous month", <ChevronLeft size={14} />)}
        <span className="flex-1 text-center text-sm font-medium">{fmt(month, { month: "long", year: "numeric" })}</span>
        {nav(1, "Next month", <ChevronRight size={14} />)}
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-ink-3">
        {WEEKDAYS.map((d) => (
          <span key={d} className="py-1">
            {d.slice(0, 2)}
          </span>
        ))}
        {monthDays(month).map((d) => {
          const has = (ctx.byDay.get(d) ?? []).some((i) => i.type === "post");
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              disabled={d > ctx.last}
              aria-label={formatDate(d, true)}
              aria-current={d === anchor ? "date" : undefined}
              className={cx(
                "relative mx-auto grid size-8 place-items-center rounded-full text-xs tabular-nums transition-colors disabled:opacity-30",
                d === anchor ? "bg-ink font-semibold text-canvas" : d === ctx.today ? "font-semibold text-ai hover:bg-subtle" : "hover:bg-subtle",
                !d.startsWith(month.slice(0, 7)) && d !== anchor && "text-ink-3/60",
              )}
            >
              {Number(d.slice(8))}
              {has && <span aria-hidden className={cx("absolute bottom-1 size-1 rounded-full", d === anchor ? "bg-canvas" : "bg-ai")} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The picked post, in full: what it says, where it goes, and the one action that matters. */
function Details({ item, tz }: { item: Posted; tz: string }) {
  const { post } = item;
  const text = post.thread[0]?.text.trim();
  const links = post.targets.filter((t) => t.url).map((t) => t.url!);
  if (post.url) links.push(post.url);
  return (
    <div className="rounded-xl border border-line bg-surface p-3 shadow-xs">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cx("h-3.5 w-1 rounded-full border-l-2", tone(post))} />
        <time dateTime={item.at} className="font-medium tabular-nums">
          {formatWhen(item.at, tz)}
        </time>
        <span className="text-ink-3 capitalize">{post.status}</span>
        <ApprovalPill post={post} />
        {post.targets.length > 0 && (
          <span className="ml-auto">
            <TargetIcons post={post} />
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-[12] text-sm leading-relaxed break-words whitespace-pre-wrap">{text || <span className="text-ink-3">Empty post</span>}</p>
      {post.thread.length > 1 && <p className="mt-1 text-xs text-ink-3">+{post.thread.length - 1} in thread</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => openPost(post.id)}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-xs font-medium text-canvas hover:opacity-90"
        >
          <PenLine size={13} /> {post.status === "published" ? "Open" : "Edit"}
        </button>
        {links[0] && (
          <a
            href={links[0]}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink"
          >
            View <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  );
}
