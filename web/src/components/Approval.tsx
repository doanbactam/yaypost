// The person's decision on agent-made posts: a status pill, and Approve / Request changes / Reject with inline notes.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, MessageSquareReply, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ControlState, Post } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { formatWhen } from "../lib/time.ts";
import { cx } from "../lib/util.ts";
import { toast, toastError } from "./Toasts.tsx";

/** "Needs approval" / "Changes requested"; nothing for posts that need no decision. */
export function ApprovalPill({ post, className }: { post: Post; className?: string }) {
  const state = post.approval?.state;
  if (state !== "pending" && state !== "changes_requested") return null;
  return (
    <span
      title={state === "changes_requested" && post.approval?.note ? `You asked: ${post.approval.note}` : undefined}
      className={cx(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        state === "pending"
          ? "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300"
          : "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
        className,
      )}
    >
      <span className={cx("size-1.5 rounded-full", state === "pending" ? "bg-violet-500" : "bg-orange-500")} />
      {state === "pending" ? "Needs approval" : "Changes requested"}
    </span>
  );
}

type Kind = "approve" | "reject" | "request_changes";

/** Decide on a post. `before` runs first (the composer saves pending edits so the decision covers what's on screen). */
export function useDecision(tz: string, onDone?: (post: Post) => void, before?: () => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ post, kind, note }: { post: Post; kind: Kind; note?: string }) => {
      await before?.();
      return kind === "approve" ? api.approve(post.id, note) : kind === "reject" ? api.reject(post.id, note) : api.requestChanges(post.id, note ?? "");
    },
    onSuccess: (saved, { kind }) => {
      qc.setQueryData<Post[]>(["approvals"], (list) =>
        kind === "request_changes" ? list?.map((p) => (p.id === saved.id ? saved : p)) : list?.filter((p) => p.id !== saved.id),
      );
      for (const key of ["control", "approvals", "audit", "queue", "posts"]) void qc.invalidateQueries({ queryKey: [key] });
      const paused = qc.getQueryData<ControlState>(["control"])?.paused;
      const future = saved.scheduledAt && Date.parse(saved.scheduledAt) > Date.now();
      toast(
        kind === "approve"
          ? {
              title: "Approved",
              description: paused
                ? "Publishing is paused: it goes out once you resume."
                : future
                  ? `Goes out ${formatWhen(saved.scheduledAt!, tz)}.`
                  : "Going out now.",
              tone: "success",
            }
          : kind === "reject"
            ? { title: "Rejected", description: "Moved back to drafts." }
            : { title: "Sent back to the agent", description: "Its revision will ask you again." },
      );
      onDone?.(saved);
    },
    onError: (e, { kind }) =>
      toastError(kind === "approve" ? "Couldn't approve" : kind === "reject" ? "Couldn't reject" : "Couldn't send it back", e),
  });
}

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50";

/** Approve / Request changes / Reject, with the note fields opening inline. `extra` renders after the buttons. */
export function DecisionBar({
  post,
  tz,
  onDone,
  before,
  extra,
}: {
  post: Post;
  tz: string;
  onDone?: (post: Post) => void;
  before?: () => Promise<unknown>;
  extra?: ReactNode;
}) {
  const decide = useDecision(tz, onDone, before);
  const [mode, setMode] = useState<null | "changes" | "reject">(null);
  const [note, setNote] = useState("");
  const busy = decide.isPending ? decide.variables?.kind : null;
  const submit = () => {
    if (mode === "changes" && !note.trim()) return;
    decide.mutate({ post, kind: mode === "changes" ? "request_changes" : "reject", note: note.trim() || undefined });
  };

  if (mode)
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-2"
      >
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") setMode(null);
          }}
          rows={mode === "changes" ? 3 : 2}
          maxLength={2000}
          required={mode === "changes"}
          aria-label={mode === "changes" ? "What should the agent change?" : "Reason (optional)"}
          placeholder={mode === "changes" ? "What should the agent change? (required)" : "Reason (optional) — the agent sees it"}
          className="block w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm leading-relaxed placeholder:text-ink-3 focus:border-line-strong"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={decide.isPending || (mode === "changes" && !note.trim())}
            className={cx(btn, mode === "reject" ? "bg-red-600 text-white hover:bg-red-700" : "bg-ink text-canvas hover:opacity-90")}
          >
            {decide.isPending && <LoaderCircle size={13} className="animate-spin" />}
            {mode === "changes" ? "Send back" : "Reject"}
          </button>
          <button type="button" onClick={() => setMode(null)} className={cx(btn, "text-ink-2 hover:bg-subtle hover:text-ink")}>
            Cancel
          </button>
          <span className="text-xs text-ink-3">
            {mode === "changes" ? "The post stays blocked until the agent revises it." : "The post goes back to drafts."}
          </span>
        </div>
      </form>
    );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        onClick={() => decide.mutate({ post, kind: "approve" })}
        disabled={decide.isPending}
        className={cx(btn, "bg-ink text-canvas hover:opacity-90")}
      >
        {busy === "approve" ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />} Approve
      </button>
      <button onClick={() => (setNote(""), setMode("changes"))} disabled={decide.isPending} className={cx(btn, "border border-line bg-surface hover:bg-subtle")}>
        <MessageSquareReply size={13} /> Request changes
      </button>
      <button
        onClick={() => (setNote(""), setMode("reject"))}
        disabled={decide.isPending}
        className={cx(btn, "text-ink-2 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/50 dark:hover:text-red-300")}
      >
        <X size={13} /> Reject
      </button>
      {extra}
    </div>
  );
}
