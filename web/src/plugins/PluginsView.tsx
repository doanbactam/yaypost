// Plugins: every platform and approval chat is one. See what's loaded and from where, switch plugins on and off, and
// fill in their settings. Adding a plugin is a file-system step: <DATA_DIR>/plugins/ or plugins.load, then restart.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, MessageCircle, RefreshCw, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type PluginInfo, type PluginsState } from "../api.ts";
import { Switch } from "../components/Switch.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { useControl } from "../lib/control.ts";
import { PlatformIcon, usePlatforms } from "../lib/platforms.tsx";
import { cx } from "../lib/util.ts";
import { PluginSettingsDialog } from "./PluginSettings.tsx";

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50";
const btnQuiet = cx(btn, "border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink");
const btnPrimary = cx(btn, "bg-ink text-canvas hover:opacity-90");
const code = "rounded bg-subtle px-1 py-px font-mono text-[12px] text-ink";

const KEY = ["plugins"] as const;

/** After any change: store the new list and refresh what plugins feed (platforms, chats, accounts). */
function applyState(qc: QueryClient, state: PluginsState) {
  qc.setQueryData(KEY, state);
  for (const key of ["platforms", "control", "health", "accounts"]) void qc.invalidateQueries({ queryKey: [key] });
}

/** "Webhook and Telegram approvals": what a plugin provides, in the names people know. */
function useProvides() {
  const platforms = usePlatforms();
  const { data: control } = useControl();
  return (p: Pick<PluginInfo, "platforms" | "channels">) => [
    ...p.platforms.map((id) => ({ key: `p:${id}`, kind: "platform" as const, id, label: platforms.name(id) })),
    ...p.channels.map((id) => ({ key: `c:${id}`, kind: "chat" as const, id, label: `${channelName(control?.channels, id)} approvals` })),
  ];
}

const channelName = (channels: { id: string; name: string }[] | undefined, id: string) =>
  channels?.find((c) => c.id === id)?.name || (id ? id[0]!.toUpperCase() + id.slice(1) : id);

const GROUPS: { source: PluginInfo["source"]; title: string }[] = [
  { source: "built-in", title: "Built-in" },
  { source: "data", title: "From data folder" },
  { source: "config", title: "From config" },
];

export function PluginsView() {
  const { data, isPending, error, refetch, isRefetching } = useQuery({ queryKey: KEY, queryFn: api.plugins, staleTime: 30_000 });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] space-y-6 px-4 pt-6 pb-24 sm:px-6">
        <p className="text-sm leading-relaxed text-ink-2">
          Every platform and approval chat is a plugin. To add one, put its folder in <code className={code}>&lt;DATA_DIR&gt;/plugins/</code> or list it
          in <code className={code}>plugins.load</code> in yaypost.config.json, then restart Yaypost.
        </p>
        {isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-2xl bg-subtle" />
            ))}
          </div>
        ) : error ? (
          <ErrorBox title="Couldn't load plugins" message={error.message}>
            <button onClick={() => void refetch()} disabled={isRefetching} className={btnQuiet}>
              <RefreshCw size={13} className={cx(isRefetching && "animate-spin")} /> Retry
            </button>
          </ErrorBox>
        ) : (
          GROUPS.map((g) => {
            const list = data.plugins.filter((pl) => pl.source === g.source);
            if (!list.length) return null;
            return (
              <section key={g.source} aria-labelledby={`group-${g.source}`}>
                <h2 id={`group-${g.source}`} className="mb-1 text-xs font-medium text-ink-3">
                  {g.title}
                </h2>
                <ul className="divide-y divide-line border-y border-line">
                  {list.map((pl) => (
                    <PluginRow key={`${pl.source}:${pl.name}`} plugin={pl} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

function PluginRow({ plugin: pl }: { plugin: PluginInfo }) {
  const qc = useQueryClient();
  const provides = useProvides()(pl);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const run = useMutation({
    mutationFn: (action: "enable" | "disable") => api.pluginAction(action, pl.name),
    onSuccess: (state, action) => {
      applyState(qc, state);
      const now = state.plugins.find((p) => p.name === pl.name);
      if (now?.error && action === "enable") toast({ title: `${pl.name} didn't load`, description: now.error, tone: "error", duration: 10_000 });
      else if (action === "enable") toast({ title: `Switched on ${pl.name}`, tone: "success" });
      else toast({ title: `Switched off ${pl.name}`, description: "What it provides is gone until you switch it back on." });
    },
    onError: (e, action) => toastError(action === "enable" ? `Couldn't switch on ${pl.name}` : `Couldn't switch off ${pl.name}`, e),
  });
  const needsSetup = pl.settingsMissing.length > 0 && !pl.disabled;
  const on = !pl.disabled;

  const status = pl.disabledByConfig
    ? { label: "Off in config", tone: "bg-subtle text-ink-2" }
    : pl.disabled
      ? { label: "Off", tone: "bg-subtle text-ink-2" }
      : pl.error
        ? { label: "Failed", tone: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" }
        : null;

  return (
    <li className={cx("px-1 py-3", run.isPending && "opacity-70")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* What it provides is the identity: icons first, the package name second. */}
            {provides.map((x) =>
              x.kind === "platform" ? (
                <PlatformIcon key={x.key} platform={x.id} size={15} />
              ) : (
                <MessageCircle key={x.key} size={15} className="text-ink-3" />
              ),
            )}
            <Tip content={pl.description ? <>{pl.description}<span className="mt-1 block opacity-70">{pl.version}</span></> : pl.version}>
              <span className="cursor-default font-medium break-all text-ink">{pl.name}</span>
            </Tip>
            {status && <span className={cx("rounded-full px-2 py-px text-[11px] font-medium", status.tone)}>{status.label}</span>}
          </p>
          {pl.error && !pl.disabled && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs break-words text-red-800 dark:bg-red-950/50 dark:text-red-300">
              <CircleAlert size={13} className="mt-px shrink-0" />
              <span className="min-w-0">{pl.error}</span>
            </p>
          )}
          {pl.hasSettings && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {needsSetup ? (
                <button onClick={() => setSettingsOpen(true)} className={btnPrimary}>
                  <Settings2 size={13} /> Set up
                </button>
              ) : (
                <Tip content="Settings">
                  <button onClick={() => setSettingsOpen(true)} aria-label={`${pl.name} settings`} className={cx(btn, "px-2 text-ink-3 hover:bg-subtle hover:text-ink")}>
                    <Settings2 size={13} />
                  </button>
                </Tip>
              )}
            </div>
          )}
        </div>
        {/* The wrapper carries the tooltip: a disabled switch gets no hover or focus events. */}
        <Tip content={pl.disabledByConfig ? "Switched off in yaypost.config.json: remove it from plugins.disable there to switch it on." : undefined}>
          <span className="mt-0.5 shrink-0">
            <Switch
              checked={on}
              onChange={() => run.mutate(on ? "disable" : "enable")}
              disabled={run.isPending || pl.disabledByConfig}
              label={`${on ? "Switch off" : "Switch on"} ${pl.name}`}
            >
              {run.isPending && <LoaderCircle size={11} className="animate-spin text-ink-3" />}
            </Switch>
          </span>
        </Tip>
      </div>
      {settingsOpen && <PluginSettingsDialog name={pl.name} onClose={() => setSettingsOpen(false)} />}
    </li>
  );
}

function ErrorBox({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return (
    <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3.5 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/40 dark:text-red-50">
      <p className="flex items-center gap-2 font-medium">
        <CircleAlert size={16} className="shrink-0 text-red-600 dark:text-red-400" /> {title}
      </p>
      <p className="mt-1 text-xs break-words opacity-80">{message}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
