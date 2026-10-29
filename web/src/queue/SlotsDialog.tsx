// Posting slots: the weekly times queued posts go out at. One rule per row: days, then either a list of times or
// "every N minutes from–to". Saved to yaypost.config.json; posts already scheduled keep their times.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, LoaderCircle, PenLine, Plus, Repeat, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, type SlotRule } from "../api.ts";
import { Dialog } from "../components/Dialog.tsx";
import { daysSpec, parseDays } from "../../../shared/schedule.ts";
import { clock, DayPicker, TimeChips } from "../components/Schedule.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { cx } from "../lib/util.ts";

interface Rule {
  days: number[];
  mode: "times" | "every";
  times: string[];
  from: string;
  to: string;
  every: number;
}

const toRule = (r: SlotRule): Rule =>
  "times" in r
    ? { days: daysOf(r.days), mode: "times", times: [...r.times].sort(), from: "09:00", to: "17:00", every: 120 }
    : { days: daysOf(r.days), mode: "every", times: [], from: r.from, to: r.to, every: r.everyMinutes };
const daysOf = (spec: string) => [...(parseDays(spec) ?? [])].sort();
const fromRule = (r: Rule): SlotRule =>
  r.mode === "times" ? { days: daysSpec(r.days), times: r.times } : { days: daysSpec(r.days), from: r.from, to: r.to, everyMinutes: r.every };

const minutes = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3);
/** How many slots a rule gives a week: the number that tells you whether the schedule is about right. */
const perWeek = (r: Rule) =>
  r.days.length * (r.mode === "times" ? r.times.length : minutes(r.to) >= minutes(r.from) ? Math.floor((minutes(r.to) - minutes(r.from)) / r.every) + 1 : 0);
const problem = (r: Rule) =>
  !r.days.length ? "Pick at least one day" : r.mode === "times" ? (!r.times.length ? "Add a time" : null) : minutes(r.to) < minutes(r.from) ? "Can't cross midnight" : null;

const EVERY = [15, 30, 60, 90, 120, 180, 240];
const every = (m: number) => `every ${m < 60 || m % 60 ? `${m} min` : `${m / 60} h`}`;
const NEW_RULE: Rule = { days: [1, 2, 3, 4, 5], mode: "times", times: ["09:00"], from: "09:00", to: "17:00", every: 120 };

export function SlotsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config });
  const [rules, setRules] = useState<Rule[] | null>(null);
  if (config && !rules) setRules(config.slots.map(toRule));
  const save = useMutation({
    mutationFn: (r: Rule[]) => api.saveSlots(r.map(fromRule)),
    onSuccess: (next) => {
      qc.setQueryData(["config"], next);
      void qc.invalidateQueries({ queryKey: ["queue"] });
      toast({ title: "Posting slots saved", tone: "success" });
      onClose();
    },
    onError: (e) => toastError("Couldn't save the slots", e),
  });
  if (!config || !rules) return null;

  const set = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const total = rules.reduce((n, r) => n + perWeek(r), 0);
  const invalid = rules.some((r) => problem(r));
  const changed = JSON.stringify(rules.map(fromRule)) !== JSON.stringify(config.slots.map((s) => fromRule(toRule(s))));

  return (
    <Dialog title="Posting slots" onClose={onClose} className="w-[min(36rem,calc(100vw-2rem))]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(rules);
        }}
      >
        <ul className="divide-y divide-line">
          {rules.map((r, i) => {
            const why = problem(r);
            return (
              <li key={i} className="space-y-3 py-4 first:pt-0">
                <div className="flex items-center gap-2">
                  <DayPicker days={r.days} onChange={(days) => set(i, { days })} />
                  <Tip content="Remove">
                    <button
                      type="button"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                      aria-label="Remove these slots"
                      className="ml-auto grid size-8 place-items-center rounded-md text-ink-3 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
                    >
                      <Trash2 size={15} />
                    </button>
                  </Tip>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Tabs
                    label="Slot type"
                    size="sm"
                    value={r.mode}
                    onChange={(mode) => set(i, { mode, ...(mode === "times" && !r.times.length ? { times: [r.from] } : {}) })}
                    tabs={[
                      { value: "times", title: "At set times", label: (<><Clock size={13} /><span className="sr-only">At set times</span></>) },
                      { value: "every", title: "Every few hours", label: (<><Repeat size={13} /><span className="sr-only">Every few hours</span></>) },
                    ]}
                  />
                  {r.mode === "times" ? (
                    <TimeChips times={r.times} onChange={(times) => set(i, { times })} fallback={r.times.at(-1) ? nextHour(r.times.at(-1)!) : "09:00"} />
                  ) : (
                    <span className="flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
                      <select
                        value={r.every}
                        onChange={(e) => set(i, { every: Number(e.target.value) })}
                        aria-label="Every"
                        className="h-8 rounded-lg border border-line bg-canvas px-2 text-sm text-ink"
                      >
                        {[...new Set([...EVERY, r.every])].sort((a, b) => a - b).map((m) => (
                          <option key={m} value={m}>
                            {every(m)}
                          </option>
                        ))}
                      </select>
                      <input
                        type="time"
                        value={r.from}
                        onChange={(e) => set(i, { from: e.target.value })}
                        aria-label="From"
                        className="h-8 rounded-lg border border-line bg-canvas px-2 tabular-nums text-ink"
                      />
                      –
                      <input
                        type="time"
                        value={r.to}
                        onChange={(e) => set(i, { to: e.target.value })}
                        aria-label="To"
                        className="h-8 rounded-lg border border-line bg-canvas px-2 tabular-nums text-ink"
                      />
                    </span>
                  )}
                </div>
                {why && (
                  <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
                    {why}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          onClick={() => setRules([...rules, NEW_RULE])}
          className="mt-1 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong text-sm text-ink-2 hover:border-ink-3 hover:text-ink"
        >
          <Plus size={14} /> {rules.length ? "More slots" : "Add slots"}
        </button>

        <div className="mt-5 flex items-center gap-2">
          <Tip content={`In ${config.timezone.replace(/_/g, " ")}. Posts already scheduled keep their times.`}>
            <span className={cx("cursor-help text-xs tabular-nums", total ? "text-ink-2" : "text-amber-700 dark:text-amber-400")}>
              {total ? `${total} a week` : "No slots: “next free slot” won't work"}
            </span>
          </Tip>
          <button type="button" onClick={onClose} className="ml-auto flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!changed || invalid || save.isPending}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-xs font-medium text-canvas hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending && <LoaderCircle size={13} className="animate-spin" />} Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The time after the last one, a natural next slot to suggest. */
const nextHour = (hhmm: string) => `${String(Math.min(23, +hhmm.slice(0, 2) + 3)).padStart(2, "0")}:${hhmm.slice(3)}`;


/** The slots as a short summary you click to edit (Settings). */
export function SlotsButton({ slots }: { slots: SlotRule[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Edit posting slots"
        className="group -mr-2 flex items-start gap-2 rounded-lg px-2 py-1 text-right text-sm text-ink hover:bg-subtle"
      >
        <ul className="space-y-0.5">
          {slots.map((s, i) => (
            <li key={i}>
              <span className="text-ink-3">{s.days}</span>{" "}
              {"times" in s ? s.times.map(clock).join(", ") : `${clock(s.from)}–${clock(s.to)}, ${every(s.everyMinutes)}`}
            </li>
          ))}
          {!slots.length && <li className="text-ink-3">None</li>}
        </ul>
        <PenLine size={13} className="mt-1 shrink-0 text-ink-3 group-hover:text-ink" />
      </button>
      {open && <SlotsDialog onClose={() => setOpen(false)} />}
    </>
  );
}