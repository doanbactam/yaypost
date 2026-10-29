// The composer ("Write"): a thread as sortable post cards (or one text area), autosaved, with scheduling and approval.
// With connected accounts selected as destinations, each card counts per platform and accounts can get their own version.
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  CalendarClock,
  Copy,
  Ellipsis,
  Image as ImageIcon,
  LayoutList,
  LoaderCircle,
  Plus,
  Send,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { joinThread, splitThread, weightedLength } from "../../../shared/thread.ts";
import type { Account, Health, Post, Segment } from "../../../shared/types.ts";
import { api, ApiError, intentUrl, liveSummary, remainingThread } from "../api.ts";
import { ApprovalPill } from "../components/Approval.tsx";
import { Popover } from "../components/Popover.tsx";
import { dismissToast, toast, toastError } from "../components/Toasts.tsx";
import { useCommands, type Command } from "../lib/commands.ts";
import { copyThread as copyExport, useLiveEvent } from "../lib/live.ts";
import { adoptPostId, navigate, newDraft } from "../lib/router.ts";
import { joinedMeter, PlatformIcon, postMeters, strictest, useAccounts, usePlatforms, type Meter } from "../lib/platforms.tsx";
import { formatWhen } from "../lib/time.ts";
import { cx, keys, uid } from "../lib/util.ts";
import { AltTextDialog } from "./AltTextDialog.tsx";
import { ApprovalBanner } from "./ApprovalBanner.tsx";
import { Destinations } from "./Destinations.tsx";
import { MAX_IMAGES, PostCard, type PendingUpload } from "./PostCard.tsx";
import { ScheduleBar, type Busy } from "./ScheduleBar.tsx";
import { StatusBanner, useRetry } from "./StatusBanner.tsx";
import { blankSegment, isBlank, useDraft, type DraftTarget, type SaveState } from "./useDraft.ts";

const SEPARATOR = /^\s*-{3,}\s*$/m;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const LAST_TARGETS = "yaypost:lastTargets";

/** "Post 1 is already live on X" / "Posts 1–3 are already live on Bluesky". */
const liveText = (n: number, where: string) => (where === "X" ? liveSummary(n) : `${n === 1 ? "Post 1 is" : `Posts 1–${n} are`} already live on ${where}`);

function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // preferences are optional
  }
}

/** Split a card whose text now contains "---" lines. A trailing separator yields a new empty card to type into. */
function splitCard(value: string): string[] {
  const parts = splitThread(value);
  const pieces = value.split(new RegExp(SEPARATOR.source, "gm"));
  if (!parts.length || (pieces.length > 1 && !pieces[pieces.length - 1]!.trim())) parts.push("");
  return parts;
}

/** Dice similarity of character bigrams: how alike an edited post is to an old one (0..1). */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (t: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let shared = 0;
  for (const [g, n] of A) shared += Math.min(n, B.get(g) ?? 0);
  const total = a.length + b.length - 2;
  return total > 0 ? (2 * shared) / total : 0;
}

/**
 * Text mode → segments, keeping each post's segment (id, images) wherever it can tell which post is which:
 * 1. posts whose text is unchanged (longest common subsequence against `base`, the thread when text mode opened,
 *    so an edit typed back restores every image where it was);
 * 2. unchanged posts that were moved;
 * 3. edited posts, matched within each gap between the anchors above to the most similar old post there.
 * Anything left is a new post without images.
 */
function segmentsFromText(text: string, base: Segment[], prev: Segment[]): Segment[] {
  const parts = splitThread(text);
  if (!parts.length) return [{ ...(base[0] ?? blankSegment()), text: "" }];
  const old = base.map((s) => s.text.trim());
  const n = parts.length;
  const m = old.length;

  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = parts[i] === old[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const match = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (parts[i] === old[j]) match[i++] = j++;
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  const used = new Set(match.filter((j) => j >= 0));

  parts.forEach((t, i) => {
    if (match[i]! >= 0) return;
    const j = old.findIndex((o, k) => !used.has(k) && o === t);
    if (j >= 0) {
      match[i] = j;
      used.add(j);
    }
  });

  for (let i = 0, lastBase = -1; i < n; ) {
    if (match[i]! >= 0) {
      lastBase = Math.max(lastBase, match[i]!);
      i++;
      continue;
    }
    let end = i;
    while (end < n && match[end]! < 0) end++;
    const nextBase = end < n ? match[end]! : m;
    const free: number[] = [];
    for (let j = lastBase + 1; j < nextBase; j++) if (!used.has(j)) free.push(j);
    const pairs = free
      .flatMap((j) => Array.from({ length: end - i }, (_, k) => ({ k: i + k, j, score: similarity(parts[i + k]!, old[j]!) })))
      .sort((a, b) => b.score - a.score || Math.abs(a.k - i - (a.j - lastBase - 1)) - Math.abs(b.k - i - (b.j - lastBase - 1)));
    for (const { k, j } of pairs) {
      if (match[k]! < 0 && !used.has(j)) {
        match[k] = j;
        used.add(j);
      }
    }
    i = end;
  }

  const baseIds = new Set(base.map((s) => s.id));
  return parts.map((t, i): Segment => {
    if (match[i]! >= 0) return { ...base[match[i]!]!, text: t };
    const id = prev[i]?.id; // a post being typed keeps its id from one keystroke to the next
    return id && !baseIds.has(id) ? { id, text: t, mediaIds: [] } : blankSegment(t);
  });
}

interface Props {
  sessionKey: string;
  postId: string | null;
  slot: string | null;
  fromReminder: boolean;
  health: Health;
}

export function Composer(props: Props) {
  const { health, sessionKey } = props;
  const qc = useQueryClient();
  const maxChars = health.maxChars;

  const onCreated = useCallback(
    (post: Post) => {
      adoptPostId(post.id, sessionKey);
      void qc.invalidateQueries({ queryKey: ["posts"] });
    },
    [qc, sessionKey],
  );
  const draft = useDraft(props.postId, onCreated);
  const thread = draft.thread;
  const post = draft.post;
  const { data: accounts = [] } = useAccounts();
  const platforms = usePlatforms();
  const targets = draft.targets;
  const version = draft.version;
  const accountOf = (id: string) => accounts.find((a) => a.id === id);
  const readOnly = post?.status === "published" || post?.status === "publishing";
  // The version on screen already went out to its account: nothing in it can change.
  const versionProgress = version ? post?.targets.find((t) => t.accountId === version) : undefined;
  const viewLocked = readOnly || versionProgress?.status === "published";
  // A thread that stopped partway (on X, or on a destination using the thread on screen): its first posts are live,
  // so they can't change (Retry resumes by position).
  const live = useMemo(() => {
    const none = { count: 0, where: "X", url: (_i: number): string | null => null };
    if (viewLocked || !post || !thread) return none;
    let best = { count: post.xPostIds.length, where: "X", url: (i: number): string | null => `https://x.com/i/status/${post.xPostIds[i]}` };
    for (const t of post.targets) {
      const mine = version ? t.accountId === version : !t.thread;
      if (!mine || t.status === "published" || platforms.threadMode(t.platform) === "single") continue;
      if (version || t.externalIds.length > best.count) best = { count: t.externalIds.length, where: platforms.name(t.platform), url: (i) => (i === 0 ? t.url : null) };
    }
    if (version && best.where === "X") return none;
    return { ...best, count: Math.min(best.count, thread.length) };
  }, [viewLocked, post, thread, version, platforms]);
  const liveCount = live.count;
  const isLocked = (index: number) => viewLocked || index < liveCount;

  // Who the thread on screen goes to: the version's account, or every destination without its own version.
  // No destinations at all = the original single-X mode (X's weighted count against the config limit).
  const legacy = targets.length === 0;
  const activeAccounts = (version ? [version] : targets.filter((t) => !t.thread).map((t) => t.accountId))
    .map(accountOf)
    .filter((a): a is Account => Boolean(a));
  const metersFor = (seg: Segment): Meter[] =>
    legacy
      ? [{ key: "x", label: "X", platform: "x", length: weightedLength(seg.text), max: maxChars }]
      : postMeters(seg.text, seg.mediaIds.length, activeAccounts, health, platforms);
  const joined = legacy || !thread ? [] : activeAccounts.filter((a) => platforms.threadMode(a.platform) === "single").map((a) => joinedMeter(thread, a, health, platforms));
  const maxImages =
    legacy || !activeAccounts.length ? MAX_IMAGES : Math.min(...activeAccounts.map((a) => platforms.get(a.platform)?.maxImages ?? MAX_IMAGES));
  const imageRules = activeAccounts
    .map((a) => platforms.get(a.platform))
    .filter((info, i, all): info is NonNullable<typeof info> => !!info && !!(info.imageTypes || info.maxImageBytes) && all.findIndex((b) => b?.id === info.id) === i)
    .map((info) => ({ name: info.name, types: info.imageTypes, maxBytes: info.maxImageBytes }));

  const [textMode, setTextMode] = useState(() => pref("yaypost:textMode", false));
  const [uploads, setUploads] = useState<Record<string, PendingUpload[]>>({});
  const [altFor, setAltFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [slotTarget, setSlotTarget] = useState(props.slot);
  /** Why a destination would refuse the post, from the last pre-flight check; cleared by the next edit. */
  const [refusals, setRefusals] = useState<{ accountId: string | null; label: string; problem: string }[] | null>(null);
  /** What the refused action was: the banner says "Not queued", "Not published", or that a scheduled post would fail. */
  const [refusedAction, setRefusedAction] = useState<"queue" | "publish" | "scheduled">("queue");

  const textareas = useRef(new Map<string, HTMLTextAreaElement>());
  const pendingFocus = useRef<{ id: string; at: "start" | "end" } | null>(null);
  const autoFocused = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleting = useRef<string | null>(null);

  useLayoutEffect(() => {
    // A fresh draft focuses its first card so typing starts immediately.
    if (thread && !autoFocused.current) {
      autoFocused.current = true;
      if (!props.postId && isBlank(thread)) pendingFocus.current = { id: thread[0]!.id, at: "end" };
    }
    const f = pendingFocus.current;
    if (!f) return;
    const el = textareas.current.get(f.id);
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    const pos = f.at === "start" ? 0 : el.value.length;
    el.setSelectionRange(pos, pos);
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  // Keep the drafts sidebar title in sync without waiting for the SSE round trip.
  useEffect(() => {
    if (!post) return;
    qc.setQueryData<Post[]>(["posts", "draft"], (list) => list?.map((p) => (p.id === post.id ? post : p)));
  }, [post, qc]);

  useLiveEvent((event) => {
    if (event.type === "post.deleted") {
      if (event.id === draft.currentId() && event.id !== deleting.current) {
        toast({ title: "This draft was deleted elsewhere" });
        newDraft();
      }
    } else if ("post" in event) draft.applyRemote(event.post);
  });

  const empty = !draft.sharedThread || isBlank(draft.sharedThread);
  const segIndex = (id: string) => draft.thread?.findIndex((s) => s.id === id) ?? -1;
  const focusCard = (id: string, at: "start" | "end") => (pendingFocus.current = { id, at });

  const edit = (next: Segment[] | ((prev: Segment[]) => Segment[])) => {
    setRefusals(null);
    draft.setThread(next);
  };

  const setTargets = (next: DraftTarget[]) => {
    setRefusals(null);
    draft.setTargets(next);
  };
  const switchVersion = (id: string | null) => {
    draft.setVersion(id);
  };
  // A new post starts with the destinations picked last time (still connected, still healthy).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || props.postId || !thread || !accounts.length) return;
    seeded.current = true;
    if (draft.targets.length) return;
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem(LAST_TARGETS) ?? "[]") as string[];
    } catch {
      // no remembered destinations
    }
    const pick = accounts.filter((a) => ids.includes(a.id) && !a.lastError);
    if (pick.length) draft.setTargets(pick.map((a) => ({ accountId: a.id, thread: null })));
  }, [props.postId, thread, accounts, draft]);
  const toggleTarget = (a: Account) => {
    const before = draft.targets;
    const existing = before.find((t) => t.accountId === a.id);
    const next = existing ? before.filter((t) => t !== existing) : [...before, { accountId: a.id, thread: null }];
    try {
      localStorage.setItem(LAST_TARGETS, JSON.stringify(next.map((t) => t.accountId)));
    } catch {
      // preferences are optional
    }
    setTargets(next);
    if (existing?.thread)
      toast({ title: `Removed ${a.label} and its own version`, actions: [{ label: "Undo", onClick: () => setTargets(before) }], duration: 8000 });
  };
  /** Fork the shared thread into a version just for this account. */
  const customize = (a: Account) => {
    const base = draft.sharedThread ?? [];
    setTargets(draft.targets.map((t) => (t.accountId === a.id ? { ...t, thread: base.map((s) => ({ ...s, id: uid() })) } : t)));
    dismissToast("preflight");
    switchVersion(a.id);
  };
  const resetVersion = (a: Account) => {
    const before = draft.targets;
    switchVersion(null);
    setTargets(before.map((t) => (t.accountId === a.id ? { ...t, thread: null } : t)));
    toast({ title: `${a.label} gets the shared thread again`, actions: [{ label: "Undo", onClick: () => setTargets(before) }], duration: 8000 });
  };
  /**
   * Ask the server what each destination would do with the saved post (limits, image counts, empty posts) and
   * refuse to queue or publish when any would be rejected.
   */
  const destinationsAccept = async (id: string, action: "queue" | "publish" | "scheduled"): Promise<boolean> => {
    if (!draft.targets.length) return true;
    const preview = await api.preview(id);
    const bad = preview.filter((t) => t.problem).map((t) => ({ accountId: t.accountId, label: t.label, problem: t.problem! }));
    if (!bad.length) return true;
    setRefusals(bad);
    setRefusedAction(action);
    const first = bad[0]!;
    const acct = first.accountId ? accountOf(first.accountId) : undefined;
    const forkable = acct && !draft.targets.find((t) => t.accountId === acct.id)?.thread;
    toast({
      id: "preflight",
      title:
        action === "scheduled"
          ? `Still scheduled, but ${bad.length > 1 ? `${bad.length} destinations` : first.label} would refuse it`
          : bad.length > 1
            ? `${bad.length} destinations would refuse this post`
            : `${first.label} would refuse this post`,
      description: bad.length > 1 ? "Details are above the thread." : first.problem,
      tone: "error",
      duration: 12_000,
      actions: forkable ? [{ label: `Customize for ${acct.label}`, onClick: () => customize(acct) }] : undefined,
    });
    return false;
  };

  const onCardChange = (id: string, value: string) => {
    if (!SEPARATOR.test(value)) {
      edit((prev) => prev.map((s) => (s.id === id ? { ...s, text: value } : s)));
      return;
    }
    const parts = splitCard(value);
    edit((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      const replaced = parts.map((t, j) => (j === 0 ? { ...prev[i]!, text: t } : blankSegment(t)));
      focusCard(replaced[replaced.length - 1]!.id, "end");
      return [...prev.slice(0, i), ...replaced, ...prev.slice(i + 1)];
    });
  };

  const addPost = (afterText?: { id: string; text: string }) => {
    const seg = blankSegment();
    edit((prev) => [...prev.map((s) => (afterText && s.id === afterText.id ? { ...s, text: afterText.text } : s)), seg]);
    focusCard(seg.id, "end");
  };

  const removePost = (id: string) => {
    const i = segIndex(id);
    if (isLocked(i)) return;
    edit((prev) => (prev.length > 1 ? prev.filter((s) => s.id !== id) : prev));
    const neighbour = draft.thread?.[i > 0 ? i - 1 : 1];
    if (neighbour) focusCard(neighbour.id, "end");
  };

  const onCardKeyDown = (seg: Segment) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const list = draft.thread ?? [];
    const i = list.findIndex((s) => s.id === seg.id);
    const collapsed = el.selectionStart === el.selectionEnd;
    const atStart = collapsed && el.selectionStart === 0;
    const atEnd = collapsed && el.selectionEnd === el.value.length;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
    const editable = !isLocked(i);
    // Two Enters make a blank line (a paragraph break); a third at the end of the last post starts a new post.
    if (editable && e.key === "Enter" && plain && atEnd && i === list.length - 1 && el.value.endsWith("\n\n") && el.value.trim()) {
      e.preventDefault();
      addPost({ id: seg.id, text: el.value.replace(/\n+$/, "") });
    } else if (e.key === "Enter" && plain && !el.value && i > 0) {
      e.preventDefault(); // e.g. Enter right after typing "---": don't start the new post with a blank line
    } else if (editable && e.key === "Backspace" && plain && !el.value && i > 0 && !seg.mediaIds.length) {
      e.preventDefault();
      removePost(seg.id);
    } else if (e.key === "ArrowUp" && plain && atStart && i > 0) {
      e.preventDefault();
      focusCard(list[i - 1]!.id, "end");
    } else if (e.key === "ArrowDown" && plain && atEnd && i < list.length - 1) {
      e.preventDefault();
      focusCard(list[i + 1]!.id, "start");
    }
  };

  const addImages = async (segId: string, files: File[]) => {
    const seg = draft.thread?.find((s) => s.id === segId);
    if (!seg) return;
    const room = maxImages - seg.mediaIds.length - (uploads[segId]?.length ?? 0);
    if (files.length > room) toast({ title: `Up to ${maxImages} images per post`, tone: "error" });
    const accepted = files.slice(0, Math.max(room, 0)).filter((f) => {
      if (!IMAGE_TYPES.includes(f.type)) toast({ title: `${f.name || "That file"} isn't a PNG, JPEG, WebP or GIF`, tone: "error" });
      else if (f.size > MAX_IMAGE_BYTES) toast({ title: `${f.name || "Image"} is over X's 5 MB limit`, tone: "error" });
      else return true;
      return false;
    });
    const pending = accepted.map((file) => ({ key: uid(), url: URL.createObjectURL(file), file }));
    if (!pending.length) return;
    setUploads((u) => ({ ...u, [segId]: [...(u[segId] ?? []), ...pending] }));
    await Promise.all(
      pending.map(async (item) => {
        try {
          const media = await api.uploadMedia(item.file);
          qc.setQueryData(["media", media.id], media);
          edit((prev) => prev.map((s) => (s.id === segId ? { ...s, mediaIds: [...s.mediaIds, media.id] } : s)));
        } catch (e) {
          toastError(`Couldn't upload ${item.file.name || "the image"}`, e);
        } finally {
          setUploads((u) => ({ ...u, [segId]: (u[segId] ?? []).filter((x) => x.key !== item.key) }));
          URL.revokeObjectURL(item.url);
        }
      }),
    );
  };

  // Single-X mode only; with destinations the server's pre-flight (destinationsAccept) decides.
  const overLimit = () => (draft.targets.length ? -1 : (draft.sharedThread ?? []).findIndex((s) => weightedLength(s.text) > maxChars));

  const slotPassed = (at: string) =>
    toast({
      title: `${formatWhen(at, health.timezone)} has already passed`,
      description: "Pick a later time, or use the next free slot.",
      tone: "error",
      duration: 10_000,
      actions: [
        {
          label: "Use next free slot",
          primary: true,
          onClick: () => {
            setSlotTarget(null);
            void actions.current.schedule("next");
          },
        },
      ],
    });

  /** Save, then schedule. "next" lets the server pick the next free slot. */
  const schedule = async (at: string) => {
    if (empty) return toast({ title: "Write something first" });
    if (at !== "next" && Date.parse(at) < Date.now() - 60_000) return slotPassed(at);
    const over = overLimit();
    if (over >= 0)
      return toast({
        title: `Post ${over + 1} is over the ${maxChars} limit`,
        description: "Shorten it before scheduling.",
        tone: "error",
      });
    setBusy("queue");
    try {
      await draft.flush();
      const id = draft.currentId();
      if (!id) throw new Error("The draft hasn't been saved yet");
      if (!(await destinationsAccept(id, "queue"))) return setBusy(null);
      const saved = await api.schedule(id, at);
      setPickerOpen(false);
      toast({
        title: `Queued for ${formatWhen(saved.scheduledAt!, health.timezone)}`,
        tone: "success",
        actions: [
          { label: "View queue", onClick: () => navigate("/queue") },
          { label: "Edit", onClick: () => navigate(`/write?post=${id}`) },
        ],
      });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["slots"] });
      newDraft();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && at !== "next" && Date.parse(at) < Date.now()) slotPassed(at);
      else toastError("Couldn't schedule", e);
      setBusy(null);
    }
  };

  /** Ctrl+Enter / palette "Add to queue": what the footer's main button does; a scheduled post keeps its time. */
  const queueShortcut = () => {
    if (readOnly) return;
    if (post?.status === "failed" && post.targets.length) {
      return toast({ id: "use-retry", title: "This post already went out partly", description: "Use “Retry” to post to the destinations that failed." });
    }
    if (post?.status === "scheduled" && post.scheduledAt) {
      const when = formatWhen(post.scheduledAt, health.timezone);
      const over = overLimit();
      if (over >= 0)
        return toast({
          id: "still-scheduled",
          title: `Post ${over + 1} is over the ${maxChars} limit`,
          description: `It's still scheduled for ${when} and would fail then. Shorten it, or unschedule it.`,
          tone: "error",
          duration: 12_000,
        });
      void (async () => {
        try {
          await draft.flush();
          const id = draft.currentId();
          if (id && !(await destinationsAccept(id, "scheduled"))) return;
          toast({ id: "still-scheduled", title: `Saved · still scheduled for ${when}`, description: "Use “Change time” to move it." });
        } catch (e) {
          toastError("Couldn't check the post", e);
        }
      })();
      return;
    }
    void schedule(slotTarget ?? "next");
  };

  const unschedule = async () => {
    const id = draft.currentId();
    if (!id) return;
    setBusy("unschedule");
    try {
      draft.setPost(await api.unschedule(id));
      toast({ title: "Moved back to drafts" });
    } catch (e) {
      toastError("Couldn't unschedule", e);
    } finally {
      setBusy(null);
    }
  };

  const publishNow = async () => {
    if (overLimit() >= 0) return toast({ title: "A post is over the character limit", tone: "error" });
    setBusy("publish");
    try {
      await draft.flush();
      if (!(await destinationsAccept(draft.currentId()!, "publish"))) return;
      const result = await api.publish(draft.currentId()!);
      draft.setPost(result);
      if (result.targets.length) {
        const ok = result.targets.filter((t) => t.status === "published").length;
        toast(
          result.status === "published"
            ? { id: `published-${result.id}`, title: `Published to ${ok === 1 ? "1 destination" : `${ok} destinations`}`, tone: "success" }
            : { id: `failed-${result.id}`, title: `Published to ${ok} of ${result.targets.length} destinations`, description: "See what failed above the thread.", tone: "error" },
        );
      } else if (result.status === "published")
        toast({
          id: `published-${result.id}`,
          title: "Posted to X",
          tone: "success",
          actions: result.url ? [{ label: "View on X", onClick: () => open(result.url!, "_blank", "noopener") }] : undefined,
        });
    } catch (e) {
      toastError("Couldn't publish", e);
    } finally {
      setBusy(null);
    }
  };

  /** Starts the clipboard write synchronously (gesture), resolving the text after the save + export. */
  const copyThread = async (): Promise<boolean> => {
    if (empty) {
      toast({ title: "Nothing to copy yet" });
      return false;
    }
    return copyExport(draft.flush().then(() => draft.currentId()!));
  };

  const deleteDraft = async () => {
    const id = draft.currentId();
    if (id && !confirmDelete) return setConfirmDelete(true);
    setMenuOpen(false);
    if (!id) return newDraft();
    deleting.current = id;
    try {
      await api.deletePost(id);
      void qc.invalidateQueries({ queryKey: ["posts"] });
      toast({ title: post?.status === "draft" ? "Draft deleted" : "Post deleted" });
      newDraft();
    } catch (e) {
      deleting.current = null;
      setConfirmDelete(false);
      toastError("Couldn't delete", e);
    }
  };

  const toggleText = () =>
    setTextMode((v) => {
      savePref("yaypost:textMode", !v);
      return !v;
    });

  // Latest handlers for global shortcuts and palette commands (registered once).
  const actions = useRef({ schedule, queueShortcut, copyThread, toggleText, publishNow, setPickerOpen });
  useEffect(() => {
    actions.current = { schedule, queueShortcut, copyThread, toggleText, publishNow, setPickerOpen };
  });

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Shortcuts belong to the thread editor or the page, not to other fields (mark-posted URL, time picker,
      // inline notes) or dialogs on top of it (alt text, palette), which handle their own keys.
      const field = e.target instanceof Element ? e.target.closest("input, textarea, select, [contenteditable='true'], dialog") : null;
      if (!mod || e.defaultPrevented || (field && !field.closest("[data-thread-editor]"))) return;
      const a = actions.current;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        a.queueShortcut();
      } else if (e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void a.copyThread();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const retry = useRetry(post, draft.flush, draft.setPost);
  const hasTargets = targets.length > 0;
  const commands = useMemo<Command[]>(() => {
    const a = () => actions.current;
    const list: Command[] = [
      { id: "queue", group: "Thread", title: "Add to queue", icon: CalendarClock, shortcut: keys.queue, run: () => a().queueShortcut() },
      { id: "pick", group: "Thread", title: "Schedule for a specific time…", icon: CalendarClock, run: () => a().setPickerOpen(true) },
      { id: "copy", group: "Thread", title: "Copy thread", icon: Copy, shortcut: keys.copy, run: () => void a().copyThread() },
      { id: "text", group: "Thread", title: "Toggle text mode", icon: AlignLeft, keywords: "cards markdown plain", run: () => a().toggleText() },
    ];
    if (health.x.mode === "api" || hasTargets)
      list.push({ id: "publish", group: "Thread", title: "Publish now", icon: Send, run: () => void a().publishNow() });
    return list;
  }, [health.x.mode, hasTargets]);
  useCommands("composer", commands);

  if (draft.missing)
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div>
          <p className="font-medium">This post no longer exists</p>
          <button onClick={() => newDraft()} className="mt-4 rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-canvas">
            Start a new draft
          </button>
        </div>
      </div>
    );

  const showText = textMode && !viewLocked && liveCount === 0;
  // "Open in X" prefills the first post that isn't on X yet, as a reply when earlier posts are live.
  const shared = draft.sharedThread;
  const openInX = post && shared ? remainingThread({ ...post, thread: shared }).intent : intentUrl(shared?.[0]?.text ?? "");

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-6">
          <StatusLabel post={post} saveState={draft.saveState} tz={health.timezone} />
          {post && <ApprovalPill post={post} className="max-sm:hidden" />}
          <div className="flex-1" />
          {!viewLocked && (
            <div role="group" aria-label="Editor mode" className="flex rounded-lg border border-line p-0.5">
              {[
                { on: !showText, icon: LayoutList, label: "Cards" },
                { on: showText, icon: AlignLeft, label: "Text" },
              ].map(({ on, icon: Icon, label }) => (
                <button
                  key={label}
                  aria-pressed={on}
                  onClick={() => !on && toggleText()}
                  disabled={label === "Text" && liveCount > 0}
                  title={
                    label === "Cards"
                      ? "One card per post"
                      : liveCount > 0
                        ? `Text mode is off for this thread: ${liveText(liveCount, live.where)} and can't be changed. Edit the rest as cards.`
                        : "Whole thread as one text, posts separated by ---"
                  }
                  className={cx(
                    "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    on ? "bg-subtle text-ink" : "text-ink-3 enabled:hover:text-ink",
                  )}
                >
                  <Icon size={14} />
                  <span className="max-sm:hidden">{label}</span>
                </button>
              ))}
            </div>
          )}
          <Popover
            trigger={
              <button aria-label="More" className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-subtle">
                <Ellipsis size={16} />
              </button>
            }
            open={menuOpen}
            onOpenChange={(open) => (setMenuOpen(open), setConfirmDelete(false))}
            align="end"
            className="w-52 p-1"
          >
              <button
                onClick={() => {
                  setMenuOpen(false);
                  newDraft();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-subtle"
              >
                <Plus size={15} /> New draft
              </button>
              {post && post.status !== "publishing" && post.status !== "published" && (
                <button
                  onClick={() => void deleteDraft()}
                  className={cx(
                    "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm",
                    confirmDelete ? "bg-red-600 font-medium text-white" : "text-red-600 hover:bg-subtle",
                  )}
                >
                  <Trash2 size={15} /> {confirmDelete ? "Click again to delete" : `Delete ${post.status === "draft" ? "draft" : "post"}`}
                </button>
              )}
          </Popover>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[640px] px-3 pt-2 pb-16 sm:px-6">
            {thread && (accounts.length > 0 || targets.length > 0) && (
              <Destinations
                accounts={accounts}
                targets={targets}
                shared={draft.sharedThread}
                post={post}
                health={health}
                readOnly={readOnly}
                version={version}
                onToggle={toggleTarget}
                onVersion={switchVersion}
                onCustomize={customize}
                onReset={resetVersion}
              />
            )}
            {refusals && (
              <div role="alert" className="mb-4 ml-10 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100">
                <p className="font-medium">
                  {refusedAction === "scheduled"
                    ? `Still scheduled, but ${refusals.length > 1 ? "these destinations" : refusals[0]!.label} would refuse it at its time. Fix it or unschedule it.`
                    : `${refusedAction === "publish" ? "Not published" : "Not queued"}: ${refusals.length > 1 ? "these destinations" : refusals[0]!.label} would refuse it`}
                </p>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {refusals.map((r) => (
                    <li key={r.accountId ?? "x"}>
                      <span className="font-medium">{r.label}:</span> {r.problem}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {post && <ApprovalBanner post={post} tz={health.timezone} flush={draft.flush} onChange={draft.setPost} />}
            {post && (
              <StatusBanner
                post={post}
                health={health}
                fromReminder={props.fromReminder}
                onCopy={copyThread}
                onPublish={publishNow}
                flush={draft.flush}
                onChange={draft.setPost}
              />
            )}
            {slotTarget && !post?.scheduledAt && (
              <p className="mb-3 ml-10 flex flex-wrap items-center gap-x-2 text-xs text-ink-3">
                <span>
                  Writing for the slot at <span className="font-medium text-ink-2">{formatWhen(slotTarget, health.timezone)}</span>
                  {Date.parse(slotTarget) < Date.now() && <span className="text-amber-700 dark:text-amber-400"> (already passed)</span>}
                </span>
                <button onClick={() => setSlotTarget(null)} className="underline-offset-2 hover:text-ink hover:underline">
                  Use next free slot instead
                </button>
              </p>
            )}

            <div data-thread-editor>
            {!thread ? (
              <div className="ml-10 space-y-3" aria-busy>
                <div className="h-28 animate-pulse rounded-2xl bg-subtle" />
                <div className="h-20 animate-pulse rounded-2xl bg-subtle" />
              </div>
            ) : showText ? (
              <TextMode key={version ?? "shared"} thread={thread} meter={(t, images) => strictest(metersFor({ id: "", text: t, mediaIds: Array(images).fill("") }))} onChange={edit} />
            ) : (
              <Cards
                thread={thread}
                onReorder={(e) => {
                  const from = thread.findIndex((s) => s.id === e.active.id);
                  const to = thread.findIndex((s) => s.id === e.over?.id);
                  // Live posts stay where they are; nothing moves above them.
                  if (from >= liveCount && to >= liveCount && from !== to) edit((prev) => arrayMove(prev, from, to));
                }}
              >
                {thread.map((seg, i) => (
                  <PostCard
                    key={seg.id}
                    segment={seg}
                    index={i}
                    total={thread.length}
                    meters={metersFor(seg)}
                    maxImages={maxImages}
                    imageRules={imageRules}
                    readOnly={isLocked(i)}
                    live={i < liveCount ? { where: live.where, url: live.url(i) } : undefined}
                    uploads={uploads[seg.id] ?? []}
                    textareaRef={(el) => (el ? textareas.current.set(seg.id, el) : textareas.current.delete(seg.id))}
                    onChange={(v) => onCardChange(seg.id, v)}
                    onKeyDown={onCardKeyDown(seg)}
                    onRemove={() => removePost(seg.id)}
                    onFiles={(files) => void addImages(seg.id, files)}
                    onRemoveImage={(mid) => edit((prev) => prev.map((s) => (s.id === seg.id ? { ...s, mediaIds: s.mediaIds.filter((m) => m !== mid) } : s)))}
                    onEditImage={setAltFor}
                  />
                ))}
              </Cards>
            )}
            </div>

            {joined.map((m) => (
              <p
                key={m.key}
                className={cx(
                  "mb-2 ml-10 flex items-center gap-1.5 text-xs tabular-nums",
                  m.length > m.max ? "font-medium text-red-600 dark:text-red-400" : "text-ink-3",
                )}
              >
                <PlatformIcon platform={m.platform} size={12} tint={false} />
                {m.label}: {thread!.length > 1 ? "joined into one post" : "one post"} · {m.length}/{m.max}
                {m.length > m.max && " · too long, shorten it or customize a version"}
              </p>
            ))}
            {!legacy && !version && !activeAccounts.length && thread && !readOnly && targets.some((t) => t.thread && !t.snapshot) && (
              <p className="mb-2 ml-10 text-xs text-ink-3">Every destination has its own version, so this shared thread isn't posted anywhere.</p>
            )}

            {thread && !viewLocked && !showText && (
              <div className="flex items-center gap-3 pl-10">
                <button
                  onClick={() => addPost()}
                  className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap text-ink-2 hover:bg-subtle hover:text-ink"
                >
                  <Plus size={16} /> Add post
                </button>
              </div>
            )}
          </div>
        </div>

        {thread && !readOnly && (
          <footer className="shrink-0 border-t border-line bg-canvas/85 px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
            <div className="mx-auto max-w-[640px]">
              <ScheduleBar
                health={health}
                post={post}
                empty={empty}
                openInX={openInX}
                live={version ? 0 : liveCount}
                destinations={targets.length}
                slotTarget={slotTarget}
                pickerOpen={pickerOpen}
                setPickerOpen={setPickerOpen}
                busy={busy}
                onQueue={() => void schedule(slotTarget ?? "next")}
                onSchedule={(iso) => void schedule(iso)}
                onUnschedule={() => void unschedule()}
                onPublish={() => void publishNow()}
                onCopy={() => void copyThread()}
                retry={
                  post?.status === "failed" && post.targets.length
                    ? {
                        published: post.targets.filter((t) => t.status === "published").length,
                        total: post.targets.length,
                        pending: retry.isPending,
                        run: () => retry.mutate(),
                      }
                    : undefined
                }
              />
            </div>
          </footer>
        )}
      </div>

      {altFor && <AltTextDialog mediaId={altFor} onClose={() => setAltFor(null)} />}
    </div>
  );
}

function Cards(p: { thread: Segment[]; onReorder: (e: DragEndEvent) => void; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={p.onReorder}>
      <SortableContext items={p.thread.map((s) => s.id)} strategy={verticalListSortingStrategy}>
        <div>{p.children}</div>
      </SortableContext>
    </DndContext>
  );
}

function TextMode(p: { thread: Segment[]; meter: (text: string, images: number) => Meter | null; onChange: (thread: Segment[]) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sig = JSON.stringify(p.thread.map((s) => s.text));
  // Raw text is local while typing; resync (and re-base the image mapping) when the thread changes from
  // elsewhere (an agent, another device).
  const [raw, setRaw] = useState(() => ({ text: joinThread(p.thread.map((s) => s.text)), sig, base: p.thread }));
  if (raw.sig !== sig && JSON.stringify(splitThread(raw.text)) !== JSON.stringify(p.thread.map((s) => s.text.trim()).filter(Boolean))) {
    setRaw({ text: joinThread(p.thread.map((s) => s.text)), sig, base: p.thread });
  }
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 240)}px`;
  }, [raw.text]);
  const parts = splitThread(raw.text);
  const kept = new Set(p.thread.flatMap((s) => s.mediaIds));
  const dropped = raw.base.flatMap((s) => s.mediaIds).filter((m) => !kept.has(m)).length;
  return (
    <div className="ml-10">
      <div className="rounded-2xl border border-line bg-surface px-4 py-3 focus-within:border-line-strong">
        <textarea
          ref={ref}
          autoFocus
          value={raw.text}
          onChange={(e) => {
            setRaw({ ...raw, text: e.target.value });
            p.onChange(segmentsFromText(e.target.value, raw.base, p.thread));
          }}
          spellCheck
          aria-label="Thread as text"
          placeholder={"First post\n\n---\n\nSecond post"}
          className="block w-full resize-none overflow-hidden bg-transparent text-base leading-relaxed placeholder:text-ink-3 sm:text-[17px]"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs tabular-nums">
        {parts.map((t, i) => {
          const images = p.thread[i]?.mediaIds.length ?? 0;
          const m = p.meter(t, images);
          const over = m ? m.length > m.max : false;
          return (
            <span
              key={i}
              title={m ? `${m.length}/${m.max} on ${m.label}` : undefined}
              className={cx(
                "flex items-center gap-1 rounded-full px-2 py-0.5",
                over ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-subtle text-ink-2",
              )}
            >
              {i + 1} · {m ? (over ? `${m.platform !== "x" ? `${m.label} ` : ""}−${m.length - m.max}` : m.length) : t.length}
              {images > 0 && (
                <span className="flex items-center gap-0.5" title={`${images} image${images > 1 ? "s" : ""}`}>
                  · <ImageIcon size={11} aria-label="images" /> {images}
                </span>
              )}
            </span>
          );
        })}
        <span className="px-1 text-ink-3">Separate posts with a line containing only ---</span>
      </div>
      {dropped > 0 && (
        <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
          {dropped} image{dropped > 1 ? "s" : ""} belonged to a post you removed and will be dropped. Undo ({keys.undo}) to keep{" "}
          {dropped > 1 ? "them" : "it"}.
        </p>
      )}
    </div>
  );
}

function StatusLabel({ post, saveState, tz }: { post: Post | null; saveState: SaveState; tz: string }) {
  const status = post?.status ?? "draft";
  const label = { draft: "Draft", scheduled: "Scheduled", due: "Due now", publishing: "Publishing", published: "Published", failed: "Failed" }[
    status
  ];
  const dot = {
    draft: "bg-ink-3",
    scheduled: "bg-sky-500",
    due: "bg-amber-500",
    publishing: "bg-sky-500 animate-pulse",
    published: "bg-emerald-500",
    failed: "bg-red-500",
  }[status];
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <span className={cx("size-2 shrink-0 rounded-full", dot)} />
      <span className="font-medium">{label}</span>
      {status === "scheduled" && post?.scheduledAt && <span className="truncate text-ink-2 max-sm:hidden">{formatWhen(post.scheduledAt, tz)}</span>}
      <span className="flex items-center gap-1 text-xs text-ink-3" aria-live="polite">
        {saveState === "saving" && (
          <>
            <LoaderCircle size={12} className="animate-spin" /> Saving…
          </>
        )}
        {saveState === "saved" && "Saved"}
        {saveState === "offline" && <span className="text-amber-600 dark:text-amber-400">Offline · kept locally, retrying</span>}
      </span>
    </div>
  );
}
