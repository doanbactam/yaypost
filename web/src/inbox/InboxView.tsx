// Inbox: the control room. Agents do the work; the person decides here — waiting approvals, the kill switch,
// the approval chats (from plugins: Telegram, Discord…) and a readable activity log.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CircleAlert,
  CirclePause,
  CirclePlay,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Inbox,
  LoaderCircle,
  MessageCircle,
  MessageSquareReply,
  PenLine,
  Send,
  Settings2,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { AuditEntry, ControlState, Health, Post } from "../../../shared/types.ts";
import { api, type PreviewTarget } from "../api.ts";
import { DecisionBar } from "../components/Approval.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Popover } from "../components/Popover.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { useControl } from "../lib/control.ts";
import { actorName, askerLabel, deciderLabel } from "../lib/actors.ts";
import { PlatformIcon } from "../lib/platforms.tsx";
import { openPost } from "../lib/router.ts";
import { formatWhen, timeAgo } from "../lib/time.ts";
import { cx, firstLine } from "../lib/util.ts";
import { PluginSettingsDialog } from "../plugins/PluginSettings.tsx";

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50";

export function InboxView({ health }: { health: Health }) {
  const control = useControl();
  const approvals = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, refetchInterval: 60_000 });
  const pending = approvals.data?.filter((p) => p.approval?.state === "pending") ?? [];
  const sentBack = approvals.data?.filter((p) => p.approval?.state === "changes_requested") ?? [];
  const tz = health.timezone;
  const paused = control.data?.paused ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] space-y-6 px-4 pt-5 pb-24 sm:px-6">
        {/* The systems that feed this inbox, as status you can open; the kill switch sits with them. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <ChannelChips control={control.data} />
          <div className="flex-1" />
          {control.data && !paused && <PauseButton />}
        </div>

        {paused && <PausedBanner paused={paused} />}

        <section aria-label="Waiting for you">
          {approvals.isPending ? (
            <div className="h-32 animate-pulse rounded-2xl bg-subtle" />
          ) : approvals.error ? (
            <p className="text-sm text-red-600">Couldn't load approvals: {approvals.error.message}</p>
          ) : pending.length ? (
            <ul className="space-y-3">
              {pending.map((p) => (
                <li key={p.id}>
                  <ApprovalCard post={p} tz={tz} paused={Boolean(paused)} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              {control.data?.approval.require === "never" ? (
                <Tip content="approval.require is &quot;never&quot; in yaypost.config.json">
                  <span className="cursor-help underline decoration-dotted underline-offset-4">Agents publish without asking</span>
                </Tip>
              ) : (
                "Nothing waiting"
              )}
            </Empty>
          )}
        </section>

        {sentBack.length > 0 && (
          <section aria-label="Sent back to the agent">
            <ul className="divide-y divide-line border-y border-line">
              {sentBack.map((p) => (
                <li key={p.id}>
                  <SentBackRow post={p} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <ActivityPanel tz={tz} />
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-col items-center gap-2 py-14 text-sm text-ink-3">
      <Inbox size={22} strokeWidth={1.5} />
      {children}
    </p>
  );
}

/** A status dot with a short name that opens its details and controls. */
function StatusChip(p: { dot: string; label: ReactNode; tip?: ReactNode; open: boolean; onOpenChange: (o: boolean) => void; children: ReactNode }) {
  return (
    <Popover
      open={p.open}
      onOpenChange={p.onOpenChange}
      className="w-80 space-y-3 text-sm"
      trigger={
        <button
          aria-label={typeof p.label === "string" ? p.label : undefined}
          className="flex h-8 items-center gap-2 rounded-full border border-line bg-surface pr-3 pl-2.5 text-xs font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink data-popup-open:border-line-strong data-popup-open:text-ink"
        >
          <span className={cx("size-2 shrink-0 rounded-full", p.dot)} />
          {p.label}
        </button>
      }
    >
      {p.children}
    </Popover>
  );
}

// ---------- kill switch ----------

function useSetControl() {
  const qc = useQueryClient();
  return (state: ControlState) => {
    qc.setQueryData(["control"], state);
    void qc.invalidateQueries({ queryKey: ["audit"] });
  };
}

function PauseButton() {
  const setControl = useSetControl();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const pause = useMutation({
    mutationFn: () => api.pause(reason.trim() || undefined),
    onSuccess: (s) => {
      setControl(s);
      setOpen(false);
      setReason("");
      toast({ title: "Publishing paused", description: "Nothing goes out until you resume." });
    },
    onError: (e) => toastError("Couldn't pause", e),
  });
  if (!open)
    return (
      <button onClick={() => setOpen(true)} className={cx(btn, "border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink")}>
        <CirclePause size={14} /> Pause everything
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        pause.mutate();
      }}
      className="flex w-full flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-2 sm:w-auto"
    >
      <input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        maxLength={500}
        placeholder="Reason (optional)"
        aria-label="Reason for pausing (optional)"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-2.5 text-sm focus:border-line-strong sm:w-56"
      />
      <button type="submit" disabled={pause.isPending} className={cx(btn, "bg-red-600 text-white hover:bg-red-700")}>
        {pause.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <CirclePause size={13} />} Pause
      </button>
      <button type="button" onClick={() => setOpen(false)} className={cx(btn, "text-ink-2 hover:bg-subtle")}>
        Cancel
      </button>
    </form>
  );
}

function PausedBanner({ paused }: { paused: NonNullable<ControlState["paused"]> }) {
  const setControl = useSetControl();
  const resume = useMutation({
    mutationFn: api.resume,
    onSuccess: (s) => {
      setControl(s);
      toast({ title: "Publishing resumed", description: "Posts whose time passed go out now.", tone: "success" });
    },
    onError: (e) => toastError("Couldn't resume", e),
  });
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-50"
    >
      <CirclePause size={18} className="shrink-0 text-red-600 dark:text-red-400" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Publishing is paused</p>
        <p className="text-xs opacity-80">
          {actorName(paused.by)} paused it {timeAgo(paused.at)}
          {paused.reason ? `: “${paused.reason}”` : ""}. Nothing goes out, approved or not, until you resume.
        </p>
      </div>
      <button onClick={() => resume.mutate()} disabled={resume.isPending} className={cx(btn, "bg-ink text-canvas hover:opacity-90")}>
        {resume.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <CirclePlay size={13} />} Resume
      </button>
    </div>
  );
}

// ---------- approvals ----------

function ApprovalCard({ post, tz, paused }: { post: Post; tz: string; paused: boolean }) {
  const preview = useQuery({
    queryKey: ["preview", post.id, post.updatedAt],
    queryFn: () => api.preview(post.id),
    staleTime: 60_000,
  });
  const when = post.scheduledAt && Date.parse(post.scheduledAt) > Date.now() ? formatWhen(post.scheduledAt, tz) : null;
  const problems = preview.data?.filter((t) => t.problem).length ?? 0;
  return (
    <article className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line px-4 py-2.5 text-xs text-ink-3">
        <span className="flex items-center gap-1.5 font-medium text-ink-2">
          <Bot size={13} /> {askerLabel(post)}
        </span>
        <span>asked {post.approval?.at ? timeAgo(post.approval.at) : timeAgo(post.updatedAt)}</span>
        <span className="flex-1" />
        <span className={cx(!when && "font-medium text-amber-700 dark:text-amber-400")}>
          {paused ? "Paused · " : ""}
          {when ? `Goes out ${when}` : "Goes out as soon as you approve"}
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        {post.title && <p className="text-sm font-semibold">{post.title}</p>}
        {preview.data ? (
          <div className="space-y-3">
            {preview.data.map((t) => (
              <DestinationPreview key={t.accountId ?? t.platform} target={t} multi={preview.data.length > 1} />
            ))}
          </div>
        ) : (
          <ThreadText items={post.thread.map((s) => ({ text: s.text, images: s.mediaIds.length }))} />
        )}
        {problems > 0 && (
          <p className="flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-300">
            <CircleAlert size={13} /> {problems === 1 ? "A destination" : `${problems} destinations`} would refuse this as it is. Request changes, or open it
            and fix it.
          </p>
        )}
        <DecisionBar
          post={post}
          tz={tz}
          extra={
            <button onClick={() => openPost(post.id)} className={cx(btn, "ml-auto text-ink-2 hover:bg-subtle hover:text-ink")}>
              <PenLine size={13} /> Open
            </button>
          }
        />
      </div>
    </article>
  );
}

function DestinationPreview({ target: t, multi }: { target: PreviewTarget; multi: boolean }) {
  const posts = t.items.length;
  return (
    <div>
      {(multi || t.accountId) && (
        <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <PlatformIcon platform={t.platform} size={12} />
          <span className="font-medium text-ink-2">{t.label}</span>
          <span>
            · {posts === 1 ? "1 post" : `${posts} posts`}
            {t.threadMode === "single" && posts > 1 ? " joined into one" : ""} · limit {t.limit}
          </span>
        </p>
      )}
      <ThreadText items={t.items} limit={t.limit} />
      {t.problem && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
          <CircleAlert size={13} className="mt-px shrink-0" /> {t.problem}
        </p>
      )}
    </div>
  );
}

function ThreadText({ items, limit }: { items: { text: string; count?: number; fits?: boolean; images: number }[]; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 3);
  return (
    <ol className="space-y-1.5">
      {shown.map((it, i) => (
        <li key={i} className={cx("rounded-xl border-l-2 bg-canvas py-2 pr-3 pl-3", it.fits === false ? "border-red-500" : "border-line-strong")}>
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{it.text.trim() || <span className="text-ink-3">Empty post</span>}</p>
          {(it.count !== undefined || it.images > 0 || items.length > 1) && (
            <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-3 tabular-nums">
              {items.length > 1 && <span>{i + 1}/{items.length}</span>}
              {it.count !== undefined && (
                <span className={cx(it.fits === false && "font-medium text-red-600 dark:text-red-400")}>
                  {it.count}
                  {limit ? `/${limit}` : ""} chars
                </span>
              )}
              {it.images > 0 && (
                <span className="flex items-center gap-0.5">
                  <ImageIcon size={11} /> {it.images}
                </span>
              )}
            </p>
          )}
        </li>
      ))}
      {items.length > 3 && (
        <li>
          <button onClick={() => setAll(!all)} className="text-xs font-medium text-ink-2 hover:text-ink">
            {all ? "Show less" : `Show ${items.length - 3} more`}
          </button>
        </li>
      )}
    </ol>
  );
}

function SentBackRow({ post }: { post: Post }) {
  const text = firstLine(post.thread.find((s) => s.text.trim())?.text ?? "", 100) || "Empty post";
  return (
    <button onClick={() => openPost(post.id)} className="flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-subtle/50">
      <Tip content="Sent back. The agent's revision asks you again.">
        <MessageSquareReply size={15} className="mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
      </Tip>
      <span className="min-w-0 flex-1">
      <span className="block truncate text-sm">{post.title || text}</span>
      {post.approval?.note && (
        <span className="mt-1 block text-xs leading-relaxed break-words text-orange-800 dark:text-orange-300">
          {capitalize(deciderLabel(post.approval.by))} asked: “{post.approval.note}”
        </span>
      )}
      </span>
      {post.approval?.at && <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(post.approval.at)}</span>}
    </button>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- approval chats ----------


function ChannelChips({ control }: { control: ControlState | undefined }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const [digestOpen, setDigestOpen] = useState(false);
  const test = useMutation({
    mutationFn: () => api.testChannels(),
    onSuccess: (channels) => {
      qc.setQueryData<ControlState>(["control"], (c) => (c ? { ...c, channels } : c));
      const bad = channels.filter((c) => c.configured && (c.error || !c.connected));
      toast(
        bad.length
          ? { title: "Test message failed", description: bad.map((c) => `${c.name || c.id}: ${c.error ?? "not connected"}`).join(" · "), tone: "error" }
          : { title: "Test message sent", description: "Check your chat.", tone: "success" },
      );
    },
    onError: (e) => toastError("Couldn't send the test message", e),
  });
  const anyConfigured = control?.channels.some((c) => c.configured) ?? false;
  // Each chat comes from a plugin; its settings (bot token, chat id…) are set up on the Plugins page.
  const { data: plugins } = useQuery({ queryKey: ["plugins"], queryFn: api.plugins, staleTime: 30_000 });
  const pluginFor = (channelId: string) => plugins?.plugins.find((p) => p.channels.includes(channelId));
  const [setup, setSetup] = useState<string | null>(null);

  const channels = control?.channels ?? [];
  if (!channels.length) return null;
  // One dot for all chats: the worst state wins, so a broken chat is never hidden behind a working one.
  const dot = channels.some((c) => c.error)
    ? "bg-red-500"
    : channels.some((c) => c.configured && !c.connected)
      ? "bg-amber-500"
      : channels.some((c) => c.connected)
        ? "bg-emerald-500"
        : "bg-ink-3";

  return (
    <>
    <StatusChip dot={dot} label={<><MessageCircle size={13} /> Approval chats</>} open={open} onOpenChange={setOpen}>
      <ul className="space-y-2.5">
        {(control?.channels ?? []).map((s) => {
          const plugin = pluginFor(s.id);
          const status = !s.configured
            ? { dot: "bg-ink-3", text: "Not set up" }
            : s.error
              ? { dot: "bg-red-500", text: "Error" }
              : s.connected
                ? { dot: "bg-emerald-500", text: "Connected" }
                : { dot: "bg-amber-500", text: "Not connected yet" };
          return (
            <li key={s.id}>
              <div className="flex min-h-7 items-center gap-2">
                <span className={cx("size-2 shrink-0 rounded-full", status.dot)} />
                <span className="font-medium text-ink">{s.name || s.id}</span>
                <span className="flex-1 text-xs text-ink-3">{status.text}</span>
                {plugin?.hasSettings ? (
                  <Tip content={s.configured ? "Settings" : undefined}>
                    <button
                      onClick={() => (setOpen(false), setSetup(plugin.name))}
                      aria-label={s.configured ? `${s.name || s.id} settings` : undefined}
                      className={cx(btn, "h-7", s.configured ? "px-1.5 text-ink-3 hover:bg-subtle hover:text-ink" : "bg-ink text-canvas hover:opacity-90")}
                    >
                      <Settings2 size={12} /> {!s.configured && "Set up"}
                    </button>
                  </Tip>
                ) : (
                  !s.configured && (
                    <Tip content="Configure it as its plugin describes, then restart">
                      <CircleAlert size={14} className="text-ink-3" />
                    </Tip>
                  )
                )}
              </div>
              {s.error && (
                <p className="mt-0.5 pl-4 text-xs break-words text-red-700 dark:text-red-300">
                  {/* A plugin may end its error with a link that fixes it (e.g. Telegram's connect link): make it a button. */}
                  {s.error.split(/(https:\/\/\S+)/).map((part, i) =>
                    i % 2 ? (
                      <a
                        key={i}
                        href={part}
                        target="_blank"
                        rel="noreferrer"
                        className={cx(btn, "mt-1.5 flex h-7 w-fit bg-ink text-canvas hover:opacity-90")}
                      >
                        <Send size={12} /> Open in {s.name || s.id}
                      </a>
                    ) : (
                      part.replace(/\s*Connect:\s*$/, "")
                    ),
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Tip content={anyConfigured ? undefined : "Set up a chat first"}>
          <span>
            <button
              onClick={() => test.mutate()}
              disabled={!anyConfigured || test.isPending}
              className={cx(btn, "border border-line bg-surface text-ink hover:bg-subtle")}
            >
              {test.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Send size={13} />} Send test
            </button>
          </span>
        </Tip>
        <Tip content="What your chats get every day">
          <button onClick={() => (setOpen(false), setDigestOpen(true))} className={cx(btn, "text-ink-2 hover:bg-subtle hover:text-ink")}>
            <FileText size={13} /> Today's digest
          </button>
        </Tip>
      </div>
    </StatusChip>
      {digestOpen && <DigestDialog onClose={() => setDigestOpen(false)} />}
      {setup && <PluginSettingsDialog name={setup} onClose={() => setSetup(null)} />}
    </>
  );
}

function DigestDialog({ onClose }: { onClose: () => void }) {
  const { data, isPending, error } = useQuery({ queryKey: ["digest"], queryFn: api.digest, staleTime: 0 });
  return (
    <Dialog title="Today's digest" onClose={onClose}>
      {isPending ? (
        <div className="h-32 animate-pulse rounded-xl bg-subtle" />
      ) : error ? (
        <p className="text-sm text-red-600">{error.message}</p>
      ) : (
        <pre className="max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-canvas p-3 font-sans text-sm leading-relaxed whitespace-pre-wrap">
          {data}
        </pre>
      )}
    </Dialog>
  );
}

// ---------- activity ----------

const quote = (s: string | null) => (s ? `“${s}”` : "");

function describe(e: AuditEntry, tz: string): string {
  const who = actorName(e.actor);
  const d = e.detail;
  switch (e.action) {
    case "post.approval_requested":
      return `${who} asked to publish ${quote(d) || "a post"}`;
    case "post.approved":
      return `${who} approved a post${d ? `: ${quote(d)}` : ""}`;
    case "post.changes_requested":
      return `${who} sent a post back${d ? `: ${quote(d)}` : ""}`;
    case "post.rejected":
      return `${who} rejected a post${d ? `: ${quote(d)}` : ""}`;
    case "post.created":
      return `${who} drafted ${quote(d) || "a post"}`;
    case "post.updated":
      return `${who} edited ${quote(d) || "a post"}`;
    case "post.scheduled":
      return `${who} scheduled a post${d && !Number.isNaN(Date.parse(d)) ? ` for ${formatWhen(d, tz)}` : ""}`;
    case "post.published":
      return `${who === "The scheduler" ? "A post" : `${who} published a post`}${who === "The scheduler" ? " went out" : ""}`;
    case "post.failed":
      return `A post failed to publish${d ? `: ${d}` : ""}`;
    case "post.due":
      return `A post is due to post by hand${d ? `: ${d}` : ""}`;
    case "post.deleted":
      return `${who} deleted a post`;
    case "publishing.paused":
      return `${who} paused publishing${d ? `: ${quote(d)}` : ""}`;
    case "publishing.resumed":
      return `${who} resumed publishing`;
    case "plugin.enabled":
      return `${who} switched on the plugin ${d ?? ""}`.trim();
    case "plugin.disabled":
      return `${who} switched off the plugin ${d ?? ""}`.trim();
    case "plugin.settings_changed":
      return `${who} changed plugin settings${d ? ` (${d.replace(/:.*/, "")})` : ""}`;
    default:
      return `${who}: ${e.action}${d ? ` ${quote(d)}` : ""}`;
  }
}

const ACTION_DOT: Record<string, string> = {
  "post.approval_requested": "bg-ai",
  "post.approved": "bg-emerald-500",
  "post.published": "bg-emerald-500",
  "post.changes_requested": "bg-orange-500",
  "post.rejected": "bg-red-500",
  "post.failed": "bg-red-500",
  "publishing.paused": "bg-red-500",
  "post.due": "bg-amber-500",
};

/** An agent's "drafted" + "scheduled" lines are noise next to its "asked to publish" for the same post: keep the ask. */
function condense(entries: AuditEntry[]): AuditEntry[] {
  const asks = entries.filter((e) => e.action === "post.approval_requested");
  return entries.filter(
    (e) =>
      !(e.action === "post.created" || e.action === "post.scheduled") ||
      !asks.some((a) => a.postId === e.postId && a.actor === e.actor && Math.abs(Date.parse(a.at) - Date.parse(e.at)) < 10_000),
  );
}

function ActivityPanel({ tz }: { tz: string }) {
  const { data, isPending, error } = useQuery({ queryKey: ["audit", 60], queryFn: () => api.audit({ limit: 60 }), refetchInterval: 60_000 });
  const [all, setAll] = useState(false);
  const condensed = data && condense(data).slice(0, 30);
  const entries = all ? condensed : condensed?.slice(0, 6);
  if (isPending) return <div className="h-24 animate-pulse rounded-xl bg-subtle" />;
  if (error) return <p className="text-sm text-red-600">Couldn't load activity: {error.message}</p>;
  if (!entries?.length) return null;
  return (
    <section aria-label="Activity" className="border-t border-line pt-4">
        <ul className="-mx-2">
          {entries.map((e) => {
            const url = e.action === "post.published" && e.detail?.startsWith("http") ? e.detail.split(" ")[0] : null;
            const text = url ? describe({ ...e, detail: null }, tz) : describe(e, tz);
            const linkable = e.postId && e.action !== "post.deleted";
            return (
              <li key={e.id} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-subtle/60">
                <span className={cx("mt-[7px] size-1.5 shrink-0 rounded-full", ACTION_DOT[e.action] ?? "bg-ink-3")} />
                <p className="min-w-0 flex-1 text-[13px] leading-snug break-words text-ink">
                  {linkable ? (
                    <button onClick={() => openPost(e.postId!)} className="text-left hover:underline">
                      {text}
                    </button>
                  ) : (
                    text
                  )}
                  {url && (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-ink-2 hover:text-ink">
                      View <ExternalLink size={11} />
                    </a>
                  )}
                </p>
                <Tip content={formatWhen(e.at, tz)}>
                  <time dateTime={e.at} className="shrink-0 pt-px text-[11px] text-ink-3 tabular-nums">
                    {timeAgo(e.at)}
                  </time>
                </Tip>
              </li>
            );
          })}
        </ul>
        {condensed!.length > entries.length && (
          <button onClick={() => setAll(true)} className="mt-1 text-xs font-medium text-ink-3 hover:text-ink">
            {condensed!.length - entries.length} more
          </button>
        )}
    </section>
  );
}
