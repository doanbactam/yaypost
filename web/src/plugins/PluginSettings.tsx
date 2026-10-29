// A plugin's settings form (fields declared in its package.json), used by the Plugins page and the Inbox's approval chats.
// Secrets are never shown: they read "Set" or "Not set", an empty input keeps them, Clear removes the saved one.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, KeyRound, LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import { api, type PluginSettings, type SettingField, type SettingSource, type SettingValue } from "../api.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Switch } from "../components/Switch.tsx";
import { toast } from "../components/Toasts.tsx";
import { cx } from "../lib/util.ts";

const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-50";
const input = "w-full rounded-lg border border-line bg-canvas px-3 text-sm focus:border-line-strong";

function sourceNote(f: SettingField, source: SettingSource): string {
  switch (source) {
    case "saved":
      return f.secret ? "Set (saved here)" : "Saved here";
    case "config":
      return "From yaypost.config.json";
    case "env":
      return f.secret ? `Set from .env (${f.env})` : `From .env ${f.env}`;
    case "default":
      return `Default${f.default !== undefined && f.default !== "" ? ` ${String(f.default)}` : ""}`;
    default:
      return f.env ? `Not set (or set ${f.env} in .env)` : "Not set";
  }
}

const asText = (v: SettingValue | undefined) => (v === null || v === undefined ? "" : String(v));

export function PluginSettingsDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const settings = useQuery({ queryKey: ["plugin-settings", name], queryFn: () => api.pluginSettings(name), staleTime: 0, retry: false });
  return (
    <Dialog title={`${name} settings`} onClose={onClose} className="w-[min(34rem,calc(100vw-2rem))]">
      {settings.isPending ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      ) : settings.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">Couldn't load the settings: {settings.error.message}</span>
        </p>
      ) : (
        <SettingsForm key={JSON.stringify(settings.data)} data={settings.data} onClose={onClose} />
      )}
    </Dialog>
  );
}

function SettingsForm({ data, onClose }: { data: PluginSettings; onClose: () => void }) {
  const qc = useQueryClient();
  const initial = Object.fromEntries(data.fields.map((f) => [f.key, f.secret ? "" : f.type === "boolean" ? Boolean(data.values[f.key] ?? f.default) : asText(data.values[f.key])]));
  const [draft, setDraft] = useState<Record<string, string | boolean>>(initial);
  const [cleared, setCleared] = useState<Set<string>>(new Set());

  /** Only what changed: a new value, null to clear a saved one; secrets left empty are kept. */
  const patch = (): Record<string, SettingValue> => {
    const out: Record<string, SettingValue> = {};
    for (const f of data.fields) {
      if (cleared.has(f.key)) {
        out[f.key] = null;
        continue;
      }
      const v = draft[f.key];
      if (f.secret) {
        if (typeof v === "string" && v.trim()) out[f.key] = v.trim();
        continue;
      }
      if (v === initial[f.key]) continue;
      if (f.type === "boolean") out[f.key] = Boolean(v);
      else if (typeof v === "string" && !v.trim()) out[f.key] = data.sources[f.key] === "saved" ? null : "";
      else out[f.key] = f.type === "number" ? Number(v) : String(v).trim();
    }
    for (const [k, v] of Object.entries(out)) if (v === "") delete out[k];
    return out;
  };
  const changes = patch();
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: () => api.savePluginSettings(data.name, changes),
    onSuccess: (res) => {
      const { plugin, ...view } = res;
      qc.setQueryData(["plugin-settings", data.name], view);
      for (const key of ["plugins", "control", "platforms", "health"]) void qc.invalidateQueries({ queryKey: [key] });
      if (plugin.error) toast({ title: `${data.name} didn't load with these settings`, description: plugin.error, tone: "error", duration: 10_000 });
      else
        toast({
          title: `Saved ${data.name} settings`,
          description: res.missing.length ? `Still needed: ${res.missing.map((k) => data.fields.find((f) => f.key === k)?.label ?? k).join(", ")}.` : "It reloaded with them.",
          tone: res.missing.length ? "default" : "success",
        });
      onClose();
    },
  });

  if (!data.fields.length) return <p className="text-sm text-ink-2">This plugin has no settings.</p>;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
    >
      <fieldset disabled={save.isPending} className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {data.fields.map((f) => {
          const source = data.sources[f.key] ?? "unset";
          const id = `setting-${f.key}`;
          const missing = f.required && source === "unset" && !(typeof draft[f.key] === "string" && (draft[f.key] as string).trim());
          const willClear = cleared.has(f.key);
          const canClear = source === "saved" && !willClear;
          const onText = (v: string) => {
            setDraft((d) => ({ ...d, [f.key]: v }));
            save.reset();
          };
          return (
            <div key={f.key}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <label htmlFor={id} className="flex items-center gap-1 text-sm font-medium text-ink">
                  {f.secret && <KeyRound size={12} className="text-ink-3" />}
                  {f.label}
                  {f.required && (
                    <span className="text-red-600" aria-label="required">
                      *
                    </span>
                  )}
                </label>
                <span className={cx("text-xs", missing ? "text-amber-700 dark:text-amber-300" : "text-ink-3")}>
                  {willClear ? "Cleared on save" : sourceNote(f, source)}
                  {canClear && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={() => {
                          setCleared((c) => new Set(c).add(f.key));
                          if (!f.secret) setDraft((d) => ({ ...d, [f.key]: f.type === "boolean" ? Boolean(f.default) : "" }));
                          save.reset();
                        }}
                        className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
                      >
                        Clear
                      </button>
                    </>
                  )}
                  {willClear && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={() => {
                          setCleared((c) => {
                            const n = new Set(c);
                            n.delete(f.key);
                            return n;
                          });
                          setDraft((d) => ({ ...d, [f.key]: initial[f.key]! }));
                        }}
                        className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink"
                      >
                        Undo
                      </button>
                    </>
                  )}
                </span>
              </div>
              {f.type === "boolean" ? (
                <Switch
                  id={id}
                  checked={Boolean(draft[f.key])}
                  onChange={(on) => {
                    setDraft((d) => ({ ...d, [f.key]: on }));
                    setCleared((c) => {
                      const n = new Set(c);
                      n.delete(f.key);
                      return n;
                    });
                  }}
                />
              ) : f.type === "text" ? (
                <textarea
                  id={id}
                  rows={4}
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => onText(e.target.value)}
                  placeholder={f.secret && source !== "unset" ? "Leave empty to keep the current value" : f.placeholder}
                  className={cx(input, "py-2")}
                />
              ) : (
                <input
                  id={id}
                  type={f.secret ? "password" : f.type === "number" ? "number" : "text"}
                  inputMode={f.type === "number" ? "decimal" : undefined}
                  value={String(draft[f.key] ?? "")}
                  onChange={(e) => onText(e.target.value)}
                  placeholder={
                    f.secret && source !== "unset"
                      ? "Leave empty to keep the current value"
                      : (f.placeholder ?? (f.default !== undefined ? String(f.default) : undefined))
                  }
                  autoComplete={f.secret ? "new-password" : "off"}
                  spellCheck={false}
                  aria-invalid={missing || undefined}
                  className={cx(input, "h-10", f.secret && "font-mono", missing && "border-amber-300 dark:border-amber-800")}
                />
              )}
              {f.help && <p className="mt-1 text-xs leading-relaxed text-ink-3">{f.help}</p>}
            </div>
          );
        })}
      </fieldset>

      {save.error && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm break-words text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{save.error.message}</span>
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onClose} className={cx(btn, "text-ink-2 hover:bg-subtle")}>
          Cancel
        </button>
        <button type="submit" disabled={!dirty || save.isPending} className={cx(btn, "bg-ink text-canvas hover:opacity-90")}>
          {save.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Save size={13} />} Save
        </button>
      </div>
    </form>
  );
}
