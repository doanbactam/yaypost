// Reminder notifications (Web Push): enable, test, turn off. Manual mode relies on these to tell you when to post.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, LoaderCircle } from "lucide-react";
import { api } from "../api.ts";
import { toast, toastError } from "../components/Toasts.tsx";
import { disableReminders, enableReminders, reminderState, type ReminderState } from "../lib/reminders.ts";
import { Row } from "../components/Card.tsx";
import { Switch } from "../components/Switch.tsx";
import { Tip } from "../components/Tip.tsx";

const EXPLAIN: Record<ReminderState, string> = {
  on: "This browser gets a notification when a post is due, published or fails, even with Yaypost closed.",
  off: "Get a notification at posting time with a one-click copy, even when this tab is closed.",
  denied: "Notifications are blocked for this site. Allow them in your browser's site settings, then come back.",
  insecure: "Browsers only allow push notifications on HTTPS or localhost. Put Yaypost behind HTTPS to enable reminders.",
  unsupported: "This browser doesn't support push notifications. While the tab is open you'll still see in-app reminders.",
};

export function useReminders() {
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["reminders"], queryFn: reminderState, staleTime: Infinity });
  const enable = useMutation({
    mutationFn: enableReminders,
    onSuccess: (s) => {
      qc.setQueryData(["reminders"], s);
      if (s === "on") toast({ title: "Reminders are on", description: "You'll be notified when a post is due.", tone: "success" });
      else toast({ title: "Reminders not enabled", description: EXPLAIN[s] });
    },
    onError: (e) => toastError("Couldn't enable reminders", e),
  });
  return { state: state.data, enable };
}

export function Reminders() {
  const qc = useQueryClient();
  const { state, enable } = useReminders();
  const disable = useMutation({
    mutationFn: disableReminders,
    onSuccess: (s) => qc.setQueryData(["reminders"], s),
    onError: (e) => toastError("Couldn't turn off reminders", e),
  });
  const test = useMutation({
    mutationFn: api.pushTest,
    onSuccess: (r) => toast({ title: "Test sent", description: r.message }),
    onError: (e) => toastError("Test failed", e),
  });

  const blocked = state === "denied" || state === "insecure" || state === "unsupported";
  return (
    <>
      <Row label="Reminders">
        <div className="flex items-center gap-1">
          {state === "on" && (
            <Tip content="Send a test notification">
              <button
                onClick={() => test.mutate()}
                disabled={test.isPending}
                aria-label="Send a test notification"
                className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink"
              >
                {test.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <BellRing size={14} />}
              </button>
            </Tip>
          )}
          <Tip content={state === "on" || state === "off" ? EXPLAIN[state] : undefined}>
            <span>
              <Switch
                label="Reminders"
                checked={state === "on"}
                disabled={!state || blocked || enable.isPending || disable.isPending}
                onChange={(on) => (on ? enable.mutate() : disable.mutate())}
              />
            </span>
          </Tip>
        </div>
      </Row>
      {blocked && <p className="-mt-1 border-b border-line pb-3 text-xs text-amber-800 dark:text-amber-300">{EXPLAIN[state]}</p>}
    </>
  );
}
