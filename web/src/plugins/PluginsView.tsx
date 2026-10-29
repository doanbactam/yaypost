// Plugins: every platform and approval chat is one. See what's loaded and from where, switch plugins on and off,
// install more (npm, git, a .tgz), update and uninstall them, browse the npm catalog, and restart when an update needs it.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  CircleAlert,
  Download,
  ExternalLink,
  FileArchive,
  LoaderCircle,
  MessageCircle,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type CatalogPackage, type PluginInfo, type PluginsState } from "../api.ts";
import { Checkbox } from "../components/Checkbox.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Switch } from "../components/Switch.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { useControl } from "../lib/control.ts";
import { PlatformIcon, useAccounts, usePlatforms } from "../lib/platforms.tsx";
import { navigate, useRoute } from "../lib/router.ts";
import { timeAgo } from "../lib/time.ts";
import { cx } from "../lib/util.ts";
import { PluginSettingsDialog } from "./PluginSettings.tsx";

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50";
const btnQuiet = cx(btn, "border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink");
const btnPrimary = cx(btn, "bg-ink text-canvas hover:opacity-90");
const code = "rounded bg-subtle px-1 py-px font-mono text-[12px] text-ink";

const KEY = ["plugins"] as const;
const usePluginsState = () => useQuery({ queryKey: KEY, queryFn: api.plugins, staleTime: 30_000 });

/** After any change: store the new list and refresh what plugins feed (platforms, chats, accounts, the catalog's badges). */
function applyState(qc: QueryClient, state: PluginsState) {
  qc.setQueryData(KEY, state);
  for (const key of ["platforms", "control", "health", "accounts", "plugin-catalog"]) void qc.invalidateQueries({ queryKey: [key] });
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

const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function PluginsView() {
  const { params } = useRoute();
  const tab = params.get("tab") === "discover" ? "discover" : "installed";
  const state = usePluginsState();
  const [install, setInstall] = useState<{ spec?: string } | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const canInstall = state.data?.canInstall ?? true;
  const setTab = (t: "installed" | "discover") => navigate(t === "discover" ? "/settings/plugins?tab=discover" : "/settings/plugins", { replace: true });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] space-y-6 px-4 pt-6 pb-24 sm:px-6">
        {state.data?.restartRequired && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50"
          >
            <RotateCw size={18} className="shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 basis-56">
              <p className="font-medium">Restart to finish updating</p>
              <p className="text-xs opacity-80">
                {joinAnd(state.data.plugins.filter((p) => p.restartRequired).map((p) => p.name))} {state.data.plugins.filter((p) => p.restartRequired).length === 1 ? "was" : "were"} updated. The previous
                code keeps running until Yaypost restarts.
              </p>
            </div>
            <button onClick={() => setRestartOpen(true)} className={btnPrimary}>
              <RotateCw size={13} /> Restart now
            </button>
          </div>
        )}

        <div className="flex items-end justify-between gap-3 border-b border-line">
          <div className="flex-1">
          <Tabs
            label="Plugins"
            variant="underline"
            value={tab}
            onChange={setTab}
            className="border-b-0"
            tabs={[
              {
                value: "installed",
                label: (
                  <>
                    Installed
                    {state.data && <span className="text-xs font-normal text-ink-3 tabular-nums">{state.data.plugins.length}</span>}
                  </>
                ),
              },
              { value: "discover", label: "Discover" },
            ]}
          />
          </div>
          <Tip
            content={
              canInstall ? undefined : (
                <>npm isn't available on this server. Copy a plugin's folder into &lt;DATA_DIR&gt;/plugins/, then restart.</>
              )
            }
          >
            <span className="mb-1.5">
              <button onClick={() => setInstall({})} disabled={!state.data || !canInstall} className={cx(btnPrimary, "disabled:pointer-events-none")}>
                <Plus size={14} /> Install
              </button>
            </span>
          </Tip>
        </div>

        {tab === "installed" ? (
          <InstalledTab
            state={state}
            onInstall={() => setInstall({})}
            onDiscover={() => setTab("discover")}
            onRestart={() => setRestartOpen(true)}
          />
        ) : (
          <DiscoverTab canInstall={canInstall} onInstall={(spec) => setInstall({ spec })} />
        )}
      </div>

      {install && <InstallDialog initialSpec={install.spec} onClose={() => setInstall(null)} />}
      {restartOpen && <RestartDialog onClose={() => setRestartOpen(false)} />}
    </div>
  );
}

// ---------- installed ----------

const GROUPS: { source: PluginInfo["source"]; title: string }[] = [
  { source: "installed", title: "Installed" },
  { source: "built-in", title: "Built-in" },
  { source: "data", title: "From data folder" },
  { source: "config", title: "From config" },
];

function InstalledTab(p: {
  state: ReturnType<typeof usePluginsState>;
  onInstall: () => void;
  onDiscover: () => void;
  onRestart: () => void;
}) {
  const { data, isPending, error, refetch, isRefetching } = p.state;
  if (isPending)
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-subtle" />
        ))}
      </div>
    );
  if (error)
    return (
      <ErrorBox title="Couldn't load plugins" message={error.message}>
        <button onClick={() => void refetch()} disabled={isRefetching} className={btnQuiet}>
          <RefreshCw size={13} className={cx(isRefetching && "animate-spin")} /> Retry
        </button>
      </ErrorBox>
    );
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => {
        const list = data.plugins.filter((pl) => pl.source === g.source);
        // An empty "Installed" group only matters when there is nothing else: then it is the way in.
        if (!list.length && (g.source !== "installed" || data.plugins.length > 0)) return null;
        return (
          <section key={g.source} aria-labelledby={`group-${g.source}`}>
            <h2 id={`group-${g.source}`} className="mb-1 text-xs font-medium text-ink-3">
              {g.title}
            </h2>
            {list.length ? (
              <ul className="divide-y divide-line border-y border-line">
                {list.map((pl) => (
                  <PluginRow key={`${pl.source}:${pl.name}`} plugin={pl} canInstall={data.canInstall} onRestart={p.onRestart} />
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-3 py-12 text-sm text-ink-3">
                <Puzzle size={22} strokeWidth={1.5} />
                {data.canInstall && (
                  <div className="flex flex-wrap gap-2">
                    <button onClick={p.onInstall} className={btnQuiet}>
                      <Plus size={13} /> Install plugin
                    </button>
                    <button onClick={p.onDiscover} className={btnQuiet}>
                      <Search size={13} /> Browse plugins
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

type Action = "enable" | "disable" | "update" | "uninstall";

function usePluginAction(onRestart: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, plugin }: { action: Action; plugin: PluginInfo }) => api.pluginAction(action, plugin.name),
    onSuccess: (state, { action, plugin }) => {
      applyState(qc, state);
      const now = state.plugins.find((p) => p.name === plugin.name);
      if (now?.error && action !== "disable" && action !== "uninstall") {
        toast({ title: `${plugin.name} didn't load`, description: now.error, tone: "error", duration: 10_000 });
        return;
      }
      if (action === "enable") toast({ title: `Switched on ${plugin.name}`, tone: "success" });
      else if (action === "disable")
        toast({ title: `Switched off ${plugin.name}`, description: "What it provides is gone until you switch it back on." });
      else if (action === "uninstall") toast({ title: `Uninstalled ${plugin.name}`, tone: "success" });
      else if (now?.restartRequired)
        toast({
          title: now.version === plugin.version ? `Reinstalled ${plugin.name} ${now.version}` : `Updated ${plugin.name} to ${now.version}`,
          description: "Restart Yaypost to run the new version.",
          tone: "success",
          duration: 0,
          actions: [{ label: "Restart now", primary: true, onClick: onRestart }],
        });
      else toast({ title: `${plugin.name} is up to date`, description: `Version ${now?.version ?? plugin.version}.`, tone: "success" });
    },
    onError: (e, { action, plugin }) =>
      toastError(
        { enable: `Couldn't switch on ${plugin.name}`, disable: `Couldn't switch off ${plugin.name}`, update: `Couldn't update ${plugin.name}`, uninstall: `Couldn't uninstall ${plugin.name}` }[
          action
        ],
        e,
      ),
  });
}

function PluginRow({ plugin: pl, canInstall, onRestart }: { plugin: PluginInfo; canInstall: boolean; onRestart: () => void }) {
  const provides = useProvides()(pl);
  const run = usePluginAction(onRestart);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const needsSetup = pl.settingsMissing.length > 0 && !pl.disabled;
  const busy = run.isPending ? run.variables.action : null;
  const on = !pl.disabled;

  const status = pl.disabledByConfig
    ? { label: "Off in config", tone: "bg-subtle text-ink-2" }
    : pl.disabled
      ? { label: "Off", tone: "bg-subtle text-ink-2" }
      : pl.error
        ? { label: "Failed", tone: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" }
        : pl.restartRequired
          ? { label: "Restart needed", tone: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" }
          : { label: "On", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" };

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
            <Tip content={pl.description ? <>{pl.description}<span className="mt-1 block opacity-70">{pl.version}{pl.spec ? ` · ${specLabel(pl.spec)}` : ""}</span></> : pl.version}>
              <span className="cursor-default font-medium break-all text-ink">{pl.name}</span>
            </Tip>
            {status.label !== "On" && <span className={cx("rounded-full px-2 py-px text-[11px] font-medium", status.tone)}>{status.label}</span>}
          </p>
          {pl.error && !pl.disabled && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 px-2.5 py-2 text-xs break-words text-red-800 dark:bg-red-950/50 dark:text-red-300">
              <CircleAlert size={13} className="mt-px shrink-0" />
              <span className="min-w-0">{pl.error}</span>
            </p>
          )}
          {(pl.source === "installed" || pl.hasSettings) && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {pl.hasSettings && (
                needsSetup ? (
                  <button onClick={() => setSettingsOpen(true)} className={btnPrimary}>
                    <Settings2 size={13} /> Set up
                  </button>
                ) : (
                  <Tip content="Settings">
                    <button onClick={() => setSettingsOpen(true)} aria-label={`${pl.name} settings`} className={cx(btn, "px-2 text-ink-3 hover:bg-subtle hover:text-ink")}>
                      <Settings2 size={13} />
                    </button>
                  </Tip>
                )
              )}
              {pl.source !== "installed" ? null : pl.restartRequired ? (
                <button onClick={onRestart} className={btnPrimary}>
                  <RotateCw size={13} /> Restart to finish
                </button>
              ) : (
                <Tip content={canInstall ? "Update to the latest version" : "npm isn't available on this server"}>
                  <span>
                    <button
                      onClick={() => run.mutate({ action: "update", plugin: pl })}
                      disabled={run.isPending || !canInstall}
                      aria-label={`Update ${pl.name}`}
                      className={cx(btn, "px-2 text-ink-3 hover:bg-subtle hover:text-ink")}
                    >
                      {busy === "update" ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
                    </button>
                  </span>
                </Tip>
              )}
              {pl.source === "installed" && (
                <Tip content="Uninstall">
                  <button
                    onClick={() => setConfirmUninstall(true)}
                    disabled={run.isPending}
                    aria-label={`Uninstall ${pl.name}`}
                    className={cx(btn, "px-2 text-ink-3 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/50 dark:hover:text-red-300")}
                  >
                    {busy === "uninstall" ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  </button>
                </Tip>
              )}
            </div>
          )}
        </div>
        <PluginSwitch
          checked={on}
          busy={busy === "enable" || busy === "disable"}
          disabled={run.isPending || pl.disabledByConfig}
          label={`${on ? "Switch off" : "Switch on"} ${pl.name}`}
          title={pl.disabledByConfig ? "Switched off in yaypost.config.json: remove it from plugins.disable there to switch it on." : undefined}
          onChange={() => run.mutate({ action: on ? "disable" : "enable", plugin: pl })}
        />
      </div>
      {settingsOpen && <PluginSettingsDialog name={pl.name} onClose={() => setSettingsOpen(false)} />}
      {confirmUninstall && (
        <UninstallDialog
          plugin={pl}
          pending={busy === "uninstall"}
          onClose={() => setConfirmUninstall(false)}
          onConfirm={() => run.mutate({ action: "uninstall", plugin: pl }, { onSettled: () => setConfirmUninstall(false) })}
        />
      )}
    </li>
  );
}

function PluginSwitch(p: { checked: boolean; busy: boolean; disabled: boolean; label: string; title?: string; onChange: () => void }) {
  return (
    // The wrapper carries the tooltip: a disabled button gets no hover or focus events.
    <Tip content={p.title}>
      <span className="mt-0.5 shrink-0">
        <Switch checked={p.checked} onChange={p.onChange} disabled={p.disabled} label={p.label}>
          {p.busy && <LoaderCircle size={11} className="animate-spin text-ink-3" />}
        </Switch>
      </span>
    </Tip>
  );
}

function UninstallDialog(p: { plugin: PluginInfo; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const platforms = usePlatforms();
  const { data: accounts } = useAccounts();
  const affected = accounts?.filter((a) => p.plugin.platforms.includes(a.platform)) ?? [];
  const names = p.plugin.platforms.map((id) => platforms.name(id));
  return (
    <Dialog title={`Uninstall ${p.plugin.name}?`} onClose={p.onClose}>
      <div className="space-y-3 text-sm leading-relaxed text-ink-2">
        <p>
          It's removed right away{names.length ? `, and with it ${joinAnd(names)}` : ""}
          {p.plugin.channels.length ? `${names.length ? " and" : ", and with it"} its approval chat` : ""}.
        </p>
        {names.length > 0 && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50">
            {affected.length ? (
              <>
                <span className="font-medium">
                  {affected.length} connected account{affected.length === 1 ? "" : "s"} ({joinAnd(affected.map((a) => a.label))}) will stop publishing.
                </span>{" "}
              </>
            ) : (
              <span className="font-medium">Accounts on {joinAnd(names)} stop publishing. </span>
            )}
            Posts scheduled for {names.length === 1 ? "it" : "them"} fail until you install the plugin again. Accounts and posts are kept.
          </p>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={p.onClose} className={cx(btn, "text-ink-2 hover:bg-subtle")}>
          Cancel
        </button>
        <button onClick={p.onConfirm} disabled={p.pending} className={cx(btn, "bg-red-600 text-white hover:bg-red-700")}>
          {p.pending ? <LoaderCircle size={13} className="animate-spin" /> : <Trash2 size={13} />} Uninstall {p.plugin.name}
        </button>
      </div>
    </Dialog>
  );
}

/** Uploaded packages are saved as file:tarballs/<timestamp>-<name>.tgz; show just the file's name. */
const specLabel = (spec: string) => spec.match(/^file:(?:.*\/)?\d+-([^/]+)$/)?.[1] ?? spec;

// ---------- restart ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answers = () => api.health().then(
  () => true,
  () => false,
);

/** Ask the server to restart, wait for it to go down and come back. Lives in the mutation, so it finishes even if the page unmounts. */
async function restartAndWait(): Promise<void> {
  await api.restart();
  // The old process may keep answering while it finishes in-flight publishes; wait until it stops (or 30 s pass).
  const start = Date.now();
  let wentDown = false;
  while (!wentDown && Date.now() - start < 30_000) {
    await sleep(500);
    wentDown = !(await answers());
  }
  while (!(await answers())) await sleep(1500);
}

function RestartDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [slow, setSlow] = useState(false);
  const restart = useMutation({
    mutationFn: restartAndWait,
    onSuccess: () => {
      void qc.invalidateQueries();
      toast({ title: "Yaypost restarted", description: "Updated plugins are running.", tone: "success" });
      onClose();
    },
    onError: (e) => toastError("Couldn't restart", e),
  });
  useEffect(() => {
    if (!restart.isPending) return;
    const t = setTimeout(() => setSlow(true), 60_000);
    return () => clearTimeout(t);
  }, [restart.isPending]);

  return (
    <Dialog title="Restart Yaypost?" onClose={onClose}>
      {restart.isPending ? (
        <div className="space-y-3 text-sm leading-relaxed text-ink-2" aria-live="polite">
          <p className="flex items-center gap-2 font-medium text-ink">
            <LoaderCircle size={15} className="animate-spin" /> Restarting… waiting for Yaypost to come back
          </p>
          {slow ? (
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50">
              It hasn't come back after a minute. If nothing supervises it, it stays stopped: start it again by hand (
              <code className="font-mono text-xs">pnpm start</code>). This page reconnects as soon as it answers.
            </p>
          ) : (
            null
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3 text-sm leading-relaxed text-ink-2">
            <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50">
              <span className="font-medium">It only comes back if something restarts it</span>: Docker with a restart policy, systemd with{" "}
              <code className="font-mono text-xs">Restart=on-failure</code>, pm2 or similar. If you started it by hand, it stays stopped until you start
              it again.
            </p>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className={cx(btn, "text-ink-2 hover:bg-subtle")}>
              Cancel
            </button>
            <button onClick={() => restart.mutate()} className={btnPrimary}>
              <RotateCw size={13} /> Restart now
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ---------- install ----------

const MAX_FILE = 20 * 1024 * 1024;

/** Obvious mistakes in a spec, caught before npm spends a minute on them. */
function specProblem(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  if (/^(npm|pnpm|yarn)\s+(i|install|add)\b/.test(s)) return `Leave out "${s.split(/\s+/).slice(0, 2).join(" ")}": just the package name or URL.`;
  if (/\s/.test(s)) return "No spaces: one package name or URL.";
  if (/^(\.{1,2}\/|\/|~\/|[A-Za-z]:\\)/.test(s) || /^file:/.test(s))
    return "Local folders can't be installed from here: copy the folder into <DATA_DIR>/plugins/ and restart, or upload a .tgz made with npm pack.";
  if (/^http:\/\//.test(s)) return "Use https:// links.";
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(s)) return null;
  if (/^https:\/\//.test(s) && !/\.(tgz|tar\.gz)(\?.*)?$/.test(s) && !/^https:\/\/.*\.git$/.test(s))
    return "An https:// link should point at a .tgz file. For a repository use github:user/repo or git+https://….";
  return null;
}

const EXAMPLES = ["yaypost-plugin-foo", "yaypost-plugin-foo@1.2.0", "github:user/repo", "https://example.com/plugin.tgz"];

function InstallDialog({ initialSpec, onClose }: { initialSpec?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const describe = useProvides();
  const [tab, setTab] = useState<"spec" | "file">("spec");
  const [spec, setSpec] = useState(initialSpec ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState<PluginInfo | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const install = useMutation({
    mutationFn: (what: { spec: string } | { file: File }) => ("file" in what ? api.installPluginFile(what.file) : api.installPlugin(what.spec)),
    onSuccess: async (res) => {
      applyState(qc, res);
      if (res.plugin.error) {
        if (mounted.current) setFailed(res.plugin);
        else toast({ title: `Installed ${res.plugin.name}, but it didn't load`, description: res.plugin.error, tone: "error", duration: 0 });
        return;
      }
      // Fresh names for the toast ("Webhook", not "webhook").
      await Promise.all([qc.refetchQueries({ queryKey: ["platforms"] }), qc.refetchQueries({ queryKey: ["control"] })]).catch(() => undefined);
      const what = describe(res.plugin).map((x) => x.label);
      toast({
        title: `Installed ${res.plugin.name}`,
        description: what.length ? `It provides ${joinAnd(what)}.` : "It doesn't provide any platform or chat yet.",
        tone: "success",
        duration: 6000,
      });
      onClose();
    },
    onError: (e) => {
      if (!mounted.current) toastError("Couldn't install the plugin", e);
    },
  });

  useEffect(() => {
    if (!install.isPending) return setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [install.isPending]);

  const pickFile = (f: File | undefined | null) => {
    install.reset();
    if (!f) return;
    if (!/\.(tgz|tar\.gz)$/i.test(f.name)) {
      setFile(null);
      setFileProblem(`${f.name} isn't a .tgz package. Make one with npm pack in the plugin's folder.`);
    } else if (f.size > MAX_FILE) {
      setFile(null);
      setFileProblem(`${f.name} is ${(f.size / 1024 / 1024).toFixed(1)} MB; the limit is 20 MB.`);
    } else {
      setFile(f);
      setFileProblem(null);
    }
  };

  const problem = tab === "spec" ? specProblem(spec) : fileProblem;
  const ready = agreed && !problem && (tab === "spec" ? spec.trim().length > 0 : Boolean(file));
  const serverError = install.error instanceof ApiError || install.error instanceof Error ? install.error.message : null;

  if (failed)
    return (
      <Dialog title="Installed, but it didn't load" onClose={onClose}>
        <div className="space-y-3 text-sm leading-relaxed text-ink-2">
          <p className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            <CircleAlert size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">
              <span className="font-medium">
                {failed.name} {failed.version}:
              </span>{" "}
              {failed.error}
            </span>
          </p>
        </div>
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className={btnPrimary}>
            Close
          </button>
        </div>
      </Dialog>
    );

  return (
    <Dialog title="Install a plugin" onClose={onClose} className="w-[min(34rem,calc(100vw-2rem))]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || install.isPending) return;
          install.mutate(tab === "spec" ? { spec: spec.trim() } : { file: file! });
        }}
      >
        <fieldset disabled={install.isPending} className="space-y-4">
          <Tabs
            label="Install from"
            fill
            value={tab}
            onChange={(t) => {
              setTab(t);
              install.reset();
            }}
            tabs={[
              { value: "spec", label: (<><Package size={14} /> From npm / git</>) },
              { value: "file", label: (<><Upload size={14} /> Upload .tgz</>) },
            ]}
          />

          {tab === "spec" ? (
            <div>
              <label htmlFor="plugin-spec" className="mb-1.5 block text-xs font-medium text-ink-3">
                Package name or URL
              </label>
              <input
                id="plugin-spec"
                autoFocus
                value={spec}
                onChange={(e) => {
                  setSpec(e.target.value);
                  install.reset();
                }}
                placeholder="yaypost-plugin-foo"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-invalid={Boolean(problem)}
                className={cx(
                  "h-10 w-full rounded-lg border bg-canvas px-3 font-mono text-sm focus:border-line-strong",
                  problem ? "border-red-400" : "border-line",
                )}
              />
              {problem ? (
                <p className="mt-1.5 text-xs text-red-700 dark:text-red-300">{problem}</p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  <span>For example</span>
                  {EXAMPLES.map((x) => (
                    <button
                      key={x}
                      type="button"
                      onClick={() => setSpec(x)}
                      className="rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-2 hover:border-line-strong hover:text-ink"
                    >
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  if (!install.isPending) pickFile(e.dataTransfer.files[0]);
                }}
                onClick={() => fileInput.current?.click()}
                className={cx(
                  "flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center text-sm transition-colors",
                  dragging ? "border-ink bg-subtle" : "border-line-strong bg-canvas hover:bg-subtle/60",
                )}
              >
                {file ? (
                  <>
                    <FileArchive size={22} className="text-ink-2" />
                    <span className="max-w-full truncate font-medium text-ink">{file.name}</span>
                    <span className="text-xs text-ink-3">{(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB · click to choose another</span>
                  </>
                ) : (
                  <>
                    <Upload size={22} className="text-ink-3" />
                    <span className="font-medium text-ink">Drop a .tgz here or click to choose</span>
                    <span className="text-xs text-ink-3">.tgz · 20 MB</span>
                  </>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
                className="sr-only"
                aria-label="Plugin package (.tgz)"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {fileProblem && <p className="mt-1.5 text-xs text-red-700 dark:text-red-300">{fileProblem}</p>}
            </div>
          )}

          <label
            className={cx(
              "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm leading-relaxed",
              agreed
                ? "border-line bg-canvas text-ink-2"
                : "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-50",
            )}
          >
            <Checkbox checked={agreed} onChange={setAgreed} className="mt-1" />
            <span>
              <span className="flex items-center gap-1.5 font-medium">
                <ShieldAlert size={14} className="shrink-0" /> I trust this code
              </span>
              Plugins run inside Yaypost with full access to your posts and connected accounts' credentials. Install only code you trust.
              <span className="mt-0.5 block text-xs opacity-80">Install scripts are not run.</span>
            </span>
          </label>

          {serverError && !install.isPending && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm break-words text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            >
              <CircleAlert size={16} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{serverError}</span>
            </p>
          )}
        </fieldset>

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {install.isPending && (
            <p className="mr-auto text-xs text-ink-3" aria-live="polite">
              npm{elapsed >= 3 ? ` · ${elapsed}s` : ""}
            </p>
          )}
          <button type="button" onClick={onClose} className={cx(btn, "text-ink-2 hover:bg-subtle")}>
            {install.isPending ? "Hide" : "Cancel"}
          </button>
          <button type="submit" disabled={!ready || install.isPending} className={btnPrimary}>
            {install.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
            {install.isPending ? "Installing…" : "Install"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------- discover ----------

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function DiscoverTab({ canInstall, onInstall }: { canInstall: boolean; onInstall: (spec: string) => void }) {
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 350);
  const catalog = useQuery({ queryKey: ["plugin-catalog", q], queryFn: () => api.pluginCatalog(q), staleTime: 5 * 60_000, retry: false });
  const unreachable = catalog.error instanceof ApiError && catalog.error.status === 409;

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search plugins on npm"
          aria-label="Search plugins on npm"
          className="h-10 w-full rounded-xl border border-line bg-surface pr-9 pl-9 text-sm focus:border-line-strong"
        />
        {catalog.isFetching && <LoaderCircle size={14} className="absolute top-1/2 right-3 -translate-y-1/2 animate-spin text-ink-3" />}
      </div>
      <p className="text-xs leading-relaxed text-ink-3">
        npm packages tagged <code className={code}>{catalog.data?.keyword ?? "yaypost-plugin"}</code>. Anyone can publish to npm: read a plugin's code
        before you install it.
      </p>

      {catalog.isPending ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-2xl bg-subtle" />
          ))}
        </div>
      ) : catalog.error ? (
        <ErrorBox
          title={unreachable ? "Couldn't reach npm" : "Couldn't search plugins"}
          message={unreachable ? `${catalog.error.message} Check this server's internet connection, then retry.` : catalog.error.message}
        >
          <button onClick={() => void catalog.refetch()} disabled={catalog.isFetching} className={btnQuiet}>
            <RefreshCw size={13} className={cx(catalog.isFetching && "animate-spin")} /> Retry
          </button>
        </ErrorBox>
      ) : catalog.data.packages.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {catalog.data.packages.map((pkg) => (
            <li key={pkg.name}>
              <CatalogCard pkg={pkg} canInstall={canInstall} onInstall={() => onInstall(pkg.name)} />
            </li>
          ))}
        </ul>
      ) : q ? (
        <div className="rounded-2xl border border-dashed border-line-strong px-4 py-5 text-sm text-ink-2">
          No plugins match “{q}”.{" "}
          <button onClick={() => setQuery("")} className="font-medium text-ink underline underline-offset-2">
            Show all
          </button>
        </div>
      ) : (
        <CatalogEmpty keyword={catalog.data.keyword} />
      )}
    </div>
  );
}

function CatalogCard({ pkg, canInstall, onInstall }: { pkg: CatalogPackage; canInstall: boolean; onInstall: () => void }) {
  return (
    <article className="flex h-full flex-col rounded-2xl border border-line bg-surface p-4">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium break-all text-ink">{pkg.name}</span>
        <span className="text-xs text-ink-3 tabular-nums">{pkg.version}</span>
      </p>
      <p className="mt-1 flex-1 text-sm leading-relaxed text-ink-2">{pkg.description ?? <span className="text-ink-3">No description.</span>}</p>
      <p className="mt-2 text-xs text-ink-3">
        {[pkg.publisher && `by ${pkg.publisher}`, pkg.date && `published ${timeAgo(pkg.date)}`].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pkg.installed ? (
          <span className="flex h-8 items-center gap-1.5 rounded-lg bg-emerald-100 px-2.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            Installed
          </span>
        ) : (
          <button onClick={onInstall} disabled={!canInstall} title={canInstall ? undefined : "npm isn't available on this server"} className={btnPrimary}>
            <Download size={13} /> Install
          </button>
        )}
        <a href={pkg.npmUrl} target="_blank" rel="noopener noreferrer" className={btnQuiet}>
          npm <ExternalLink size={12} />
        </a>
        {pkg.repositoryUrl && (
          <a href={pkg.repositoryUrl} target="_blank" rel="noopener noreferrer" className={btnQuiet}>
            Source <ExternalLink size={12} />
          </a>
        )}
      </div>
    </article>
  );
}

function CatalogEmpty({ keyword }: { keyword: string }) {
  const steps = useMemo(
    () => [
      <>
        Write it like the example in <code className={code}>examples/plugin-webhook</code> (about 70 lines: a platform that posts to a webhook).
      </>,
      <>
        Add <code className={code}>"keywords": ["{keyword}"]</code> and the <code className={code}>yaypost</code> manifest to its package.json.
      </>,
      <>
        Run <code className={code}>npm publish</code>. It shows up here, and anyone can install it by name.
      </>,
    ],
    [keyword],
  );
  return (
    <div className="rounded-2xl border border-dashed border-line-strong px-5 py-6 text-sm leading-relaxed text-ink-2">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-subtle text-ink-2">
          <Puzzle size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-medium text-ink">No plugins published yet</p>
          <p className="mt-0.5">Be the first. Any npm package with the {keyword} keyword is listed here.</p>
        </div>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-subtle text-[11px] font-semibold text-ink-2 tabular-nums">{i + 1}</span>
            <span className="min-w-0">{s}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs text-ink-3">
        The full guide is <code className={code}>docs/PLUGINS.md</code> in the Yaypost folder. Not ready to publish? Install your plugin from git or a .tgz
        with Install plugin.
      </p>
    </div>
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

