// App shell: auth gate, sidebar + view routing, command palette, live events, global shortcuts.
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Bell, CalendarClock, CircleCheck, CirclePause, FileText, Inbox, Menu, PenLine, Plug, Plus, Puzzle, Search, Settings2, Sparkles, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Health } from "../../shared/types.ts";
import { api, ApiError, auth } from "./api.ts";
import { Composer } from "./composer/Composer.tsx";

import { InboxView } from "./inbox/InboxView.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { useReminders } from "./connect/Reminders.tsx";
import { Palette } from "./components/Palette.tsx";
import { Logo, Sidebar } from "./components/Sidebar.tsx";
import { Toaster } from "./components/Toasts.tsx";
import { TokenPrompt } from "./components/TokenPrompt.tsx";
import { useCommands, type Command } from "./lib/commands.ts";
import { useLiveEvents } from "./lib/live.ts";
import { composerKey, navigate, newDraft, useRoute } from "./lib/router.ts";
import { keys } from "./lib/util.ts";
import { QueueView } from "./queue/QueueView.tsx";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const onUnauthorized = () => void health.refetch();
    addEventListener("yaypost:unauthorized", onUnauthorized);
    return () => removeEventListener("yaypost:unauthorized", onUnauthorized);
  }, [health]);

  const unauthorized = health.error instanceof ApiError && health.error.status === 401;
  // status 0 = no answer at all; anything else means the server runs but reported a problem.
  const serverError = health.error instanceof ApiError && health.error.status !== 0 ? health.error.message : null;
  return (
    <>
      {health.data && !unauthorized ? (
        <Shell health={health.data} />
      ) : unauthorized ? (
        <TokenPrompt retry={health.refetch} rejected={Boolean(auth.token)} />
      ) : health.error ? (
        <div className="grid min-h-full place-items-center p-6 text-center">
          <div className="max-w-sm">
            <Logo />
            {serverError ? (
              <>
                <p className="mt-4 font-medium">The Yaypost server reported a problem</p>
                <p className="mt-1 text-sm break-words text-ink-2">{serverError}</p>
                <p className="mt-1 text-sm text-ink-2">Check the server's log, fix the cause, then retry.</p>
              </>
            ) : (
              <>
                <p className="mt-4 font-medium">Can't reach the Yaypost server</p>
                <p className="mt-1 text-sm text-ink-2">
                  Start it with <code className="font-mono text-xs">pnpm dev</code> or <code className="font-mono text-xs">pnpm start</code>,
                  then retry.
                </p>
              </>
            )}
            <button onClick={() => void health.refetch()} className="mt-4 rounded-lg bg-ink px-3.5 py-2 text-sm font-medium text-canvas">
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className="grid min-h-full place-items-center">
          <div className="animate-pulse">
            <Logo />
          </div>
        </div>
      )}
      <Toaster />
    </>
  );
}

const TITLES = { inbox: "To review", compose: "Write", queue: "Queue", settings: "Settings" } as const;

/** A broken edit of yaypost.config.json: the server keeps the last good config, so this is a notice, not an outage. */
function ConfigProblem() {
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: api.config, staleTime: 15_000, refetchInterval: 30_000 });
  if (!config?.configError) return null;
  return (
    <div role="status" className="flex shrink-0 items-start gap-2.5 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-950 sm:px-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50">
      <Settings2 size={16} className="mt-0.5 shrink-0" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">Your config file has a problem</span>, so Yaypost keeps using your previous settings until it's fixed.
        Changes apply as soon as you save the file.
        <span className="mt-0.5 block font-mono text-xs break-words opacity-80">{config.configError}</span>
      </p>
    </div>
  );
}

function Shell({ health }: { health: Health }) {
  const { view, params, section } = useRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const reminders = useReminders();
  const postId = params.get("post");
  useLiveEvents();

  useEffect(() => {
    document.title = `${TITLES[view]} · Yaypost`;
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const { enable } = reminders;
  const commands = useMemo<Command[]>(
    () => [
      { id: "new", group: "Go", title: "New draft", icon: Plus, keywords: "compose write create", run: () => newDraft() },
      { id: "go-inbox", group: "Go", title: "Go to inbox", icon: Inbox, keywords: "approvals approve review decide", run: () => navigate("/") },
      { id: "go-write", group: "Go", title: "Go to composer", icon: PenLine, keywords: "write", run: () => navigate("/write") },
      { id: "go-queue", group: "Go", title: "Go to queue", icon: CalendarClock, keywords: "schedule calendar", run: () => navigate("/queue") },
      {
        id: "go-drafts",
        group: "Go",
        title: "Go to drafts",
        icon: FileText,
        run: () => {
          if (matchMedia("(min-width: 1024px)").matches) document.querySelector<HTMLButtonElement>("#drafts-list button")?.focus();
          else setDrawerOpen(true);
        },
      },
      { id: "go-published", group: "Go", title: "Published posts", icon: CircleCheck, run: () => navigate("/queue?tab=published") },
      { id: "settings", group: "Settings", title: "Settings", icon: Settings2, keywords: "preferences timezone slots approval", run: () => navigate("/settings") },
      { id: "accounts", group: "Settings", title: "Accounts", icon: Users, keywords: "connect bluesky mastodon linkedin threads x", run: () => navigate("/settings/accounts") },
      { id: "memory", group: "Settings", title: "Personalization & memory", icon: Sparkles, keywords: "feedback model operator voice ai", run: () => navigate("/settings/personalization") },
      { id: "connect", group: "Agents", title: "Connect agents (MCP, API, CLI)", icon: Plug, keywords: "mcp claude grok webhooks", run: () => navigate("/settings/agents") },
      { id: "plugins", group: "Agents", title: "Plugins (platforms & approval chats)", icon: Puzzle, keywords: "install extensions npm", run: () => navigate("/settings/plugins") },
      { id: "docs", group: "Agents", title: "Open API reference", icon: BookOpen, keywords: "openapi rest docs", run: () => open("/docs", "_blank") },
      { id: "pause", group: "Control", title: "Pause or resume publishing", icon: CirclePause, keywords: "kill switch stop", run: () => navigate("/") },
      { id: "reminders", group: "Settings", title: "Enable reminders", icon: Bell, keywords: "notifications push", run: () => enable.mutate() },
    ],
    [enable],
  );
  useCommands("app", commands);

  const sidebar = (onNavigate?: () => void) => (
    <Sidebar view={view} activePostId={postId} health={health} onOpenPalette={() => setPaletteOpen(true)} onNavigate={onNavigate} />
  );

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-64 shrink-0 border-r border-line lg:block">{sidebar()}</aside>
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div onClick={() => setDrawerOpen(false)} className="absolute inset-0 animate-fade bg-black/30" />
          <aside className="relative h-full w-[min(18rem,85vw)] animate-rise border-r border-line bg-canvas shadow-2xl">
            {sidebar(() => setDrawerOpen(false))}
          </aside>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2 lg:hidden">
          <button onClick={() => setDrawerOpen(true)} aria-label="Open menu" className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-subtle">
            <Menu size={18} />
          </button>
          <Logo />
          <span className="ml-1.5 font-semibold tracking-tight">{TITLES[view]}</span>
          <div className="flex-1" />
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label={`Commands (${keys.palette})`}
            className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-subtle"
          >
            <Search size={18} />
          </button>
          <button onClick={() => newDraft()} aria-label="New draft" className="grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-subtle">
            <Plus size={18} />
          </button>
        </div>
        <ConfigProblem />

        {view === "inbox" && <InboxView health={health} />}
        {view === "compose" && (
          <Composer
            key={composerKey(postId)}
            sessionKey={composerKey(postId)}
            postId={postId}
            slot={params.get("slot")}
            fromReminder={params.get("copy") === "1"}
            health={health}
          />
        )}
        {view === "queue" && <QueueView health={health} tab={params.get("tab") === "published" ? "published" : "upcoming"} reminders={reminders} />}
        {view === "settings" && <SettingsView health={health} section={section} />}
      </main>

      <Palette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}
