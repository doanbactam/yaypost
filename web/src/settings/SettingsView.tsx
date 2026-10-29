// Settings, laid out like ChatGPT's and Claude's: a section list on the left (a scrolling strip on phones), one
// section at a time on the right as label/value rows. Each section has its own URL (/settings/<section>).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ExternalLink, Info, PenLine, Puzzle, Settings2, Sparkles, Trash2, Users, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Feedback, Health } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { Card, Code, Row } from "../components/Card.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { Accounts } from "../connect/Accounts.tsx";
import { Reminders } from "../connect/Reminders.tsx";
import { Webhooks } from "../connect/Webhooks.tsx";
import { useControl } from "../lib/control.ts";
import { useAccounts } from "../lib/platforms.tsx";
import { navigate, openPost, type SettingsSection } from "../lib/router.ts";
import { timeAgo } from "../lib/time.ts";
import { cx } from "../lib/util.ts";
import { PluginsView } from "../plugins/PluginsView.tsx";
import { SlotsButton } from "../queue/SlotsDialog.tsx";
import { TimezonePicker } from "../components/TimezonePicker.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "personalization", label: "Personalization", icon: Sparkles },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "plugins", label: "Plugins", icon: Puzzle },
];

export function SettingsView({ health, section }: { health: Health; section: SettingsSection }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <nav aria-label="Settings" className="shrink-0 border-b border-line lg:w-56 lg:border-r lg:border-b-0">
        <h1 className="hidden px-5 pt-5 pb-3 text-lg font-semibold tracking-tight lg:block">Settings</h1>
        <div className="flex gap-1 overflow-x-auto px-2 py-2 [scrollbar-width:none] lg:flex-col lg:gap-0.5 lg:py-0">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(`/settings/${s.id}`)}
              aria-current={section === s.id ? "page" : undefined}
              // On phones the strip scrolls: keep the open section in view.
              ref={section === s.id ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
              className={cx(
                "flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm whitespace-nowrap transition-colors",
                section === s.id ? "bg-subtle font-medium text-ink" : "text-ink-2 hover:bg-subtle/70 hover:text-ink",
              )}
            >
              <s.icon size={16} className={section === s.id ? "text-ink" : "text-ink-3"} />
              {s.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {section === "plugins" ? (
          <PluginsView />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[680px] px-4 pt-5 pb-24 sm:px-6">
              <h2 className="mb-2 hidden text-base font-semibold lg:block">{SECTIONS.find((s) => s.id === section)!.label}</h2>
              {section === "general" && <General health={health} />}
              {section === "accounts" && <Accounts />}
              {section === "personalization" && <Personalization />}
              {section === "agents" && (
                <div className="space-y-7">
                  <AgentSetup health={health} />
                  <Webhooks />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** ok: green, false: needs attention (amber), null: off by choice (grey). */
const Dot = ({ ok }: { ok: boolean | null }) => (
  <span className={cx("size-2 shrink-0 rounded-full", ok === null ? "bg-line-strong" : ok ? "bg-emerald-500" : "bg-amber-500")} />
);

/** A value with a status dot; what it means and how to change it is on hover/focus. */
function Status({ ok, value, note }: { ok: boolean | null; value: string; note: string }) {
  return (
    <Tip content={note} side="left">
      <button className="flex cursor-help items-center gap-2 text-sm text-ink">
        <Dot ok={ok} />
        {value}
      </button>
    </Tip>
  );
}

function General({ health }: { health: Health }) {
  const { data: accounts } = useAccounts();
  const { data: control } = useControl();
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config });
  const n = accounts?.length ?? 0;
  const chats = control?.channels.filter((c) => c.configured).map((c) => c.name || c.id) ?? [];

  return (
    <div>
      <Row label="Publishing">
        <Status
          ok={n > 0}
          value={n ? `${n} account${n === 1 ? "" : "s"}` : "No accounts"}
          note={n ? "Posts publish to their destinations at slot time." : "Connect an account under Accounts; until then posts can only be drafts."}
        />
      </Row>
      <Row label="Approval">
        {control && (
          <Status
            ok={control.approval.require !== "never"}
            value={control.approval.require === "never" ? "Off" : "Agents need your OK"}
            note={
              control.approval.require === "never"
                ? "Agents publish without asking (approval.require in yaypost.config.json)."
                : `Agent posts wait for you in the Inbox${chats.length ? ` and ${chats.join(" and ")}` : ""}.`
            }
          />
        )}
      </Row>
      <Row label="Access">
        <Status
          ok
          value={health.auth.required ? "Token required" : "Open"}
          note={health.auth.required ? "Agents send Authorization: Bearer <AUTH_TOKEN>." : "Fine on 127.0.0.1. Set AUTH_TOKEN before exposing the port."}
        />
      </Row>
      <Reminders />
      {config && (
        <>
          <Row label="Timezone">
            <TimezonePicker value={config.timezone} className="-mr-2 rounded-lg px-2 py-1 text-sm text-ink hover:bg-subtle" />
          </Row>
          <Row label="Posting slots">
            <SlotsButton slots={config.slots} />
          </Row>
        </>
      )}
    </div>
  );
}

/** What agents work from: the voice samples and, like ChatGPT's memory, every note you left. */
function Personalization() {
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config });
  const { data: feedback } = useQuery({ queryKey: ["feedback"], queryFn: () => api.feedback() });

  return (
    <div>
      <Row label="Voice samples">
        <Tip content="Past posts agents imitate (voice in yaypost.config.json).">
          <span className="cursor-help text-sm text-ink tabular-nums">{config?.voiceCount ?? "…"}</span>
        </Tip>
      </Row>

      <div className="mt-8 flex items-center justify-between">
        <h3 className="text-sm font-medium">Memory</h3>
        <Tip content="Every agent reads these before writing (get_feedback, yaypost feedback).">
          <button aria-label="About memory" className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink">
            <Info size={15} />
          </button>
        </Tip>
      </div>
      {feedback && !feedback.length && (
        <p className="mt-2 text-sm text-ink-3">Notes you leave when approving, rejecting or sending back a post show up here.</p>
      )}
      <ul className="mt-1">
        {feedback?.map((f) => <MemoryItem key={f.id} item={f} />)}
      </ul>
    </div>
  );
}

const DECISION: Record<Feedback["decision"], { icon: LucideIcon; label: string; tone: string }> = {
  changes_requested: { icon: PenLine, label: "Sent back", tone: "text-amber-600 dark:text-amber-400" },
  rejected: { icon: X, label: "Rejected", tone: "text-red-600 dark:text-red-400" },
  approved: { icon: Check, label: "Approved", tone: "text-emerald-600 dark:text-emerald-400" },
};

function MemoryItem({ item }: { item: Feedback }) {
  const d = DECISION[item.decision];
  const title = item.post ? item.post.title || item.post.preview : null;
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const forget = useMutation({
    mutationFn: () => api.forgetFeedback(item.id),
    onSuccess: () => {
      qc.setQueryData<Feedback[]>(["feedback"], (list) => list?.filter((f) => f.id !== item.id));
      void qc.invalidateQueries({ queryKey: ["feedback"] });
      toast({
        title: "Forgotten",
        description: item.note ?? undefined,
        actions: [
          {
            label: "Undo",
            primary: true,
            onClick: () =>
              api.restoreFeedback(item.id).then(
                () => qc.invalidateQueries({ queryKey: ["feedback"] }),
                (e: unknown) => toastError("Couldn't undo", e),
              ),
          },
        ],
      });
    },
    onError: (e) => toastError("Couldn't forget this", e),
  });
  return (
    <li className={cx("group flex items-start gap-3 border-b border-line py-3", forget.isPending && "opacity-40")}>
      <Tip content={d.label}>
        <span className={cx("mt-0.5 shrink-0", d.tone)} aria-label={d.label}>
          <d.icon size={15} />
        </span>
      </Tip>
      <div className="min-w-0 flex-1">
        <p className={cx("text-sm", item.note ? "text-ink" : "text-ink-3")}>{item.note ?? "No note"}</p>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
          {title ? (
            <button onClick={() => openPost(item.postId!)} className="truncate hover:text-ink hover:underline">
              {title}
            </button>
          ) : (
            <span>Deleted post</span>
          )}
          <span className="shrink-0">· {timeAgo(item.at)}</span>
        </p>
      </div>
      <Tip content={confirm ? undefined : "Forget: agents stop seeing this note"}>
        <button
          onClick={() => (confirm ? forget.mutate() : setConfirm(true))}
          onBlur={() => setConfirm(false)}
          disabled={forget.isPending}
          aria-label={confirm ? "Confirm forget" : `Forget "${item.note ?? title ?? "this"}"`}
          className={cx(
            "grid h-7 shrink-0 place-items-center rounded-md text-xs font-medium transition-opacity",
            confirm
              ? "bg-red-600 px-2.5 text-white"
              : "w-7 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-subtle hover:text-red-600 focus-visible:opacity-100 [@media(hover:none)]:opacity-60",
          )}
        >
          {confirm ? "Forget" : <Trash2 size={14} />}
        </button>
      </Tip>
    </li>
  );
}

type Way = "mcp" | "rest" | "cli";

/** One way to connect at a time: the snippets are long, and an agent only needs one. */
function AgentSetup({ health }: { health: Health }) {
  const [way, setWay] = useState<Way>("mcp");
  const origin = location.origin;
  const mcpUrl = `${origin}/mcp`;
  const needsToken = health.auth.required;
  const authHeader = needsToken ? ` --header "Authorization: Bearer <AUTH_TOKEN>"` : "";
  const mcpJson = JSON.stringify(
    { mcpServers: { yaypost: { type: "http", url: mcpUrl, ...(needsToken ? { headers: { Authorization: "Bearer <AUTH_TOKEN>" } } : {}) } } },
    null,
    2,
  );
  const cliEnv = `YAYPOST_URL=${origin}${needsToken ? " YAYPOST_TOKEN=<AUTH_TOKEN>" : ""}`;
  const isLocal = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  const cloudNote = isLocal
    ? "claude.ai, ChatGPT and Grok connectors run in the cloud and need a public HTTPS URL (a tunnel, or your VPS behind HTTPS). Local clients like Claude Code work with this address."
    : "claude.ai, ChatGPT and Grok connectors need this server reachable over public HTTPS.";

  const links: ReactNode = (
    <div className="flex flex-wrap gap-1.5">
      {[
        { href: "/docs", label: "API reference" },
        { href: "/openapi.json", label: "openapi.json" },
        { href: "/llms.txt", label: "llms.txt" },
      ].map((d) => (
        <a
          key={d.href}
          href={d.href}
          target="_blank"
          rel="noopener"
          className="flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs font-medium text-ink-2 hover:border-line-strong hover:text-ink"
        >
          {d.label} <ExternalLink size={12} />
        </a>
      ))}
    </div>
  );

  return (
    <Card
      icon={<Bot size={16} />}
      title="Connect an agent"
      action={
        <Tabs
          label="Connect with"
          size="sm"
          value={way}
          onChange={setWay}
          tabs={[
            { value: "mcp", label: "MCP" },
            { value: "rest", label: "REST" },
            { value: "cli", label: "CLI" },
          ]}
        />
      }
    >
      {way === "mcp" && (
        <>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Code label="Endpoint" value={mcpUrl} />
            </div>
            <Tip content={cloudNote}>
              <button aria-label="Cloud connectors" className="mb-2 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink">
                <Info size={15} />
              </button>
            </Tip>
          </div>
          <Code label="Claude Code" value={`claude mcp add --transport http yaypost ${mcpUrl}${authHeader}`} />
          <Code label="MCP config" value={mcpJson} />
          {needsToken && (
            <Tip content="Only over HTTPS: a token in a URL can end up in logs. Prefer the header where a client supports it.">
              <div>
                <Code label="Without headers (claude.ai, ChatGPT, Grok)" value={`${mcpUrl}?token=<AUTH_TOKEN>`} />
              </div>
            </Tip>
          )}
        </>
      )}
      {way === "rest" && (
        <>
          {links}
          <Code
            label="Queue a thread"
            value={`curl -X POST ${origin}/api/posts \\
  -H "Content-Type: application/json"${needsToken ? ` \\\n  -H "Authorization: Bearer <AUTH_TOKEN>"` : ""} \\
  -d '{"text": "First post\\n---\\nSecond post", "scheduledAt": "next"}'`}
          />
        </>
      )}
      {way === "cli" && (
        <Code
          value={`export ${cliEnv}
node cli/yaypost.mjs queue
node cli/yaypost.mjs new "First post
---
Second post" --at next
node cli/yaypost.mjs feedback
node cli/yaypost.mjs help`}
        />
      )}
    </Card>
  );
}
