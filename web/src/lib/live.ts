// Live updates over SSE (/api/events): refresh queries, notify on approvals/due/failed/published, fan out to the composer.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { APP_EVENT_TYPES, type AppEvent, type Post } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { dismissToast, toast, toastError } from "../components/Toasts.tsx";
import { askerLabel } from "./actors.ts";
import { notifyLocally } from "./reminders.ts";
import { navigate, openPost } from "./router.ts";
import { copyText, firstLine } from "./util.ts";

const LIVE_EVENT = "yaypost:event";

/**
 * Copy a thread for posting by hand. Call it synchronously from the click (the clipboard write starts inside the
 * gesture); `id` may still be pending, e.g. while the composer saves. Resolves to whether the copy worked.
 */
export async function copyThread(id: string | Promise<string>, quiet = false): Promise<boolean> {
  try {
    const exported = typeof id === "string" ? api.exportPost(id) : id.then(api.exportPost);
    await copyText(exported.then((r) => r.text));
    const r = await exported;
    if (quiet) return true;
    toast({
      title: r.posts.length > 1 ? `Copied ${r.posts.length} posts` : "Copied",
      description: r.posts.length > 1 ? "Posts are separated by --- lines." : undefined,
      tone: "success",
    });
    return true;
  } catch (e) {
    toastError("Couldn't copy the thread", e);
    return false;
  }
}

function announceApproval(post: Post) {
  const body = firstLine(post.thread[0]?.text ?? "", 120);
  toast({
    id: `approval-${post.id}`,
    title: "Approval needed",
    description: `${askerLabel(post)} wants to publish: ${body || "an empty post"}`,
    duration: 0,
    actions: [
      { label: "Review in Inbox", primary: true, onClick: () => navigate("/") },
      { label: "Open", onClick: () => openPost(post.id) },
    ],
  });
}

function announceDue(post: Post) {
  const body = firstLine(post.thread[0]?.text ?? "", 120);
  toast({
    id: `due-${post.id}`,
    title: "Not posted yet",
    // post.error explains why a human is needed (it missed its time while the server was off).
    description: [body || "A scheduled post", post.error].filter(Boolean).join(" — "),
    duration: 0,
    actions: [{ label: "Open", primary: true, onClick: () => openPost(post.id) }],
  });
  if (document.hidden) void notifyLocally("Not posted yet", body, `/?post=${post.id}`, `due-${post.id}`);
}

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    const onEvent = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as AppEvent;
      void qc.invalidateQueries({ queryKey: ["posts"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["slots"] });
      // The control room: waiting decisions, the kill switch, who did what.
      void qc.invalidateQueries({ queryKey: ["control"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
      void qc.invalidateQueries({ queryKey: ["feedback"] });
      if (event.type === "publishing.paused" || event.type === "publishing.resumed") {
        dispatchEvent(new CustomEvent<AppEvent>(LIVE_EVENT, { detail: event }));
        if (!event.by.endsWith(":ui"))
          toast({
            id: "publishing-state",
            title: event.type === "publishing.paused" ? "Publishing paused" : "Publishing resumed",
            description: event.type === "publishing.paused" ? (event.reason ?? "Nothing goes out until you resume.") : undefined,
            tone: event.type === "publishing.paused" ? "error" : "success",
          });
        return;
      }
      // A publish can flag an account (expired token…): keep the Connect page and destination chips current.
      if (event.type === "post.published" || event.type === "post.failed") void qc.invalidateQueries({ queryKey: ["accounts"] });
      dispatchEvent(new CustomEvent<AppEvent>(LIVE_EVENT, { detail: event }));
      // A "Time to post" / "failed" alert is stale once the post has moved on (posted, retried, rescheduled, deleted).
      const post = "post" in event ? event.post : null;
      const id = post ? post.id : "id" in event ? event.id : "";
      if (post?.status !== "due") dismissToast(`due-${id}`);
      if (post?.status !== "failed") dismissToast(`failed-${id}`);
      if (post?.approval?.state !== "pending") dismissToast(`approval-${id}`);
      if (event.type === "post.approval_requested") announceApproval(event.post);
      else if (event.type === "post.due") announceDue(event.post);
      else if (event.type === "post.failed")
        toast({
          id: `failed-${event.post.id}`,
          title: "A post failed to publish",
          description: event.post.error ?? undefined,
          tone: "error",
          duration: 0,
          actions: [{ label: "Open", primary: true, onClick: () => openPost(event.post.id) }],
        });
      else if (event.type === "post.published" && event.post.targets.length) {
        const n = event.post.targets.length;
        toast({
          id: `published-${event.post.id}`,
          title: `Published to ${n === 1 ? "1 destination" : `${n} destinations`}`,
          tone: "success",
          actions: [{ label: "Open", onClick: () => openPost(event.post.id) }],
        });
      }
    };
    for (const type of APP_EVENT_TYPES) es.addEventListener(type, onEvent as EventListener);
    return () => es.close();
  }, [qc]);
}

/** Subscribe a component to live events (latest handler wins, no resubscribe churn). */
export function useLiveEvent(handler: (event: AppEvent) => void) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<AppEvent>).detail);
    addEventListener(LIVE_EVENT, listener);
    return () => removeEventListener(LIVE_EVENT, listener);
  }, []);
}
