// Draft state + autosave: the post is created on the first keystroke, then PATCHed ~600ms after edits stop.
// Every edit is mirrored to localStorage first, so a reload or crash before the save lands never loses text.
// Destinations (connected accounts, each optionally with its own version of the thread) are saved the same way;
// `version` picks which thread the editor shows: the shared one (null) or an account's own.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Post, Segment } from "../../../shared/types.ts";
import { api, ApiError, type TargetInput } from "../api.ts";
import { toastError } from "../components/Toasts.tsx";
import { uid } from "../lib/util.ts";

export type SaveState = "idle" | "saving" | "saved" | "offline";

const BUFFER_KEY = "yaypost:unsaved";
const EDITABLE: Post["status"][] = ["draft", "scheduled", "due", "failed"];
const DEBOUNCE_MS = 600;

/** A destination as edited here: an account and, when customized, its own thread. */
export interface DraftTarget {
  accountId: string;
  thread: Segment[] | null;
  /** Server-set once the destination published with the shared thread: `thread` is what it posted, not its own version. */
  snapshot?: boolean;
}

interface Buffer {
  session: string; // also the Idempotency-Key of the create request
  postId: string | null;
  thread: Segment[];
  targets?: DraftTarget[];
  at: number;
}

export const blankSegment = (text = ""): Segment => ({ id: uid(), text, mediaIds: [] });
export const isBlank = (thread: Segment[]) => thread.every((s) => !s.text.trim() && !s.mediaIds.length);
const signature = (t: Segment[]) => JSON.stringify(t.map((s) => [s.id, s.text, s.mediaIds]));
const targetSig = (t: DraftTarget[]) => JSON.stringify(t.map((x) => [x.accountId, x.thread && signature(x.thread)]));
const fromPost = (p: Post): DraftTarget[] => p.targets.map((t) => ({ accountId: t.accountId, thread: t.thread, snapshot: t.snapshot }));
const toInput = (t: DraftTarget[]): TargetInput[] => t.map((x) => ({ accountId: x.accountId, thread: x.thread }));

function readBuffer(): Buffer | null {
  try {
    return JSON.parse(localStorage.getItem(BUFFER_KEY) ?? "null") as Buffer | null;
  } catch {
    return null;
  }
}
function writeBuffer(b: Buffer) {
  try {
    localStorage.setItem(BUFFER_KEY, JSON.stringify(b));
  } catch {
    // storage full or disabled: the server save still happens
  }
}

export function useDraft(postId: string | null, onCreated: (post: Post) => void) {
  const [shared, setThreadState] = useState<Segment[] | null>(null);
  const [targets, setTargetsState] = useState<DraftTarget[]>([]);
  const [version, setVersionState] = useState<string | null>(null);
  const [post, setPost] = useState<Post | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [missing, setMissing] = useState(false);

  const r = useRef({
    id: postId,
    session: uid(),
    latest: [] as Segment[],
    targets: [] as DraftTarget[],
    targetsDirty: false,
    version: null as string | null,
    dirty: false,
    loop: null as Promise<void> | null,
    timer: 0,
    mounted: true,
    onCreated,
  }).current;
  r.onCreated = onCreated;

  const ops = useMemo(() => {
    const clearBuffer = () => {
      if (readBuffer()?.session === r.session) localStorage.removeItem(BUFFER_KEY);
    };

    const run = async () => {
      while (r.dirty) {
        r.dirty = false;
        const snapshot = r.latest;
        if (!r.id && isBlank(snapshot)) continue;
        // Destinations are sent only when they changed here, so an agent's change isn't overwritten by a text edit.
        const targetsSent = r.targetsDirty ? toInput(r.targets) : undefined;
        r.targetsDirty = false;
        setSaveState("saving");
        try {
          const saved = r.id
            ? await api.updatePost(r.id, { thread: snapshot, targets: targetsSent })
            : await api.createPost({ thread: snapshot, targets: targetsSent }, r.session);
          if (!r.id) {
            r.id = saved.id;
            // An idempotent replay returns the first version; push what we have now.
            if (signature(saved.thread) !== signature(snapshot)) r.dirty = true;
            if (r.mounted) r.onCreated(saved);
          }
          setPost(saved);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && r.id) {
            // Published or publishing meanwhile, or the edit touched posts already live: show the server's version.
            const fresh = await api.getPost(r.id).catch(() => null);
            if (fresh && EDITABLE.includes(fresh.status)) toastError("Your last edit wasn't saved", e);
            if (fresh) {
              setPost(fresh);
              r.latest = fresh.thread;
              setThreadState(fresh.thread);
              adoptTargets(fresh);
            }
            clearBuffer();
            setSaveState("idle");
            return;
          }
          r.dirty = true;
          if (targetsSent) r.targetsDirty = true;
          setSaveState("offline");
          r.timer = window.setTimeout(flush, 5000);
          return;
        }
      }
      setSaveState((s) => (s === "saving" ? "saved" : s));
      clearBuffer();
    };

    const adoptTargets = (p: Post) => {
      r.targets = fromPost(p);
      setTargetsState(r.targets);
      if (r.version && !r.targets.some((t) => t.accountId === r.version && t.thread)) {
        r.version = null;
        setVersionState(null);
      }
    };

    const schedule = () => {
      writeBuffer({ session: r.session, postId: r.id, thread: r.latest, targets: r.targets, at: Date.now() });
      window.clearTimeout(r.timer);
      if (!r.id) void flush();
      else {
        setSaveState("saving");
        r.timer = window.setTimeout(flush, DEBOUNCE_MS);
      }
    };

    const flush = (): Promise<void> => {
      window.clearTimeout(r.timer);
      r.loop ??= run().finally(() => (r.loop = null));
      return r.loop;
    };

    /** Edits the thread on screen: the shared one, or the selected account's own version. */
    const setThread = (next: Segment[] | ((prev: Segment[]) => Segment[])) => {
      const own = r.version ? r.targets.find((t) => t.accountId === r.version && t.thread) : undefined;
      if (own) {
        const value = typeof next === "function" ? next(own.thread!) : next;
        return setTargets(r.targets.map((t) => (t === own ? { ...t, thread: value } : t)));
      }
      const value = typeof next === "function" ? next(r.latest) : next;
      r.latest = value;
      r.dirty = true;
      setThreadState(value);
      schedule();
    };

    const setTargets = (next: DraftTarget[]) => {
      r.targets = next;
      r.targetsDirty = true;
      r.dirty = true;
      setTargetsState(next);
      if (r.version && !next.some((t) => t.accountId === r.version && t.thread)) setVersion(null);
      schedule();
    };

    const setVersion = (accountId: string | null) => {
      r.version = accountId;
      setVersionState(accountId);
    };

    /** Server-side change (SSE, schedule response…): adopt it unless the user has unsent edits. */
    const applyRemote = (p: Post) => {
      if (p.id !== r.id) return;
      setPost(p);
      if (r.dirty || r.loop) return;
      if (signature(p.thread) !== signature(r.latest)) {
        r.latest = p.thread;
        setThreadState(p.thread);
      }
      if (targetSig(fromPost(p)) !== targetSig(r.targets)) adoptTargets(p);
    };

    const init = (base: Segment[], server: Post | null) => {
      const buf = readBuffer();
      const matches = buf && buf.postId === (server?.id ?? null) && !isBlank(buf.thread);
      const newer = matches && (!server || buf.at > Date.parse(server.updatedAt));
      const editable = !server || EDITABLE.includes(server.status);
      const serverTargets = server ? fromPost(server) : [];
      const bufTargets = buf?.targets ?? serverTargets;
      if (buf && matches && newer && editable && (signature(buf.thread) !== signature(base) || targetSig(bufTargets) !== targetSig(serverTargets))) {
        r.session = buf.session;
        r.latest = buf.thread;
        r.targets = bufTargets;
        r.targetsDirty = targetSig(bufTargets) !== targetSig(serverTargets);
        r.dirty = true;
        setThreadState(buf.thread);
        setTargetsState(bufTargets);
        void flush();
      } else {
        r.latest = base;
        r.targets = serverTargets;
        setThreadState(base);
        setTargetsState(serverTargets);
      }
    };

    return { flush, setThread, setTargets, setVersion, applyRemote, init, setPost };
  }, [r]);

  useEffect(() => {
    let cancelled = false;
    if (!postId) ops.init([blankSegment()], null);
    else
      api.getPost(postId).then(
        (p) => {
          if (cancelled) return;
          setPost(p);
          ops.init(p.thread, p);
        },
        () => !cancelled && setMissing(true),
      );
    return () => {
      cancelled = true;
    };
    // Mount-only on purpose: the composer is keyed per post.
  }, []);

  useEffect(() => {
    r.mounted = true;
    // Last-chance save when the tab closes; keepalive lets the request outlive the page.
    const onHide = () => {
      if (!r.dirty) return;
      const targets = r.targetsDirty ? toInput(r.targets) : undefined;
      if (r.id) void api.updatePost(r.id, { thread: r.latest, targets }, true).catch(() => {});
      else if (!isBlank(r.latest)) void api.createPost({ thread: r.latest, targets }, r.session, true).catch(() => {});
    };
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      r.mounted = false;
      if (r.dirty) void ops.flush();
    };
  }, [r, ops]);

  const own = version ? targets.find((t) => t.accountId === version && t.thread) : undefined;
  return {
    /** The thread on screen (shared, or the selected version). */
    thread: own?.thread ?? shared,
    sharedThread: shared,
    targets,
    version: own ? version : null,
    post,
    saveState,
    missing,
    currentId: () => r.id,
    flush: ops.flush,
    setThread: ops.setThread,
    setTargets: ops.setTargets,
    setVersion: ops.setVersion,
    applyRemote: ops.applyRemote,
    setPost: ops.setPost,
  };
}
