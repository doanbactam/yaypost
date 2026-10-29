// Webhooks: add a URL (Slack and Discord get chat messages, anything else signed JSON), pause, change events or URL,
// and see what was sent and how the receiver answered, with resend. The signing secret is shown once.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CircleAlert, CircleCheck, LoaderCircle, Plus, RotateCcw, Trash2, Webhook as WebhookIcon, Zap } from "lucide-react";
import { useState } from "react";
import { APP_EVENT_TYPES, EVENT_GROUPS, EVENT_LABEL, type AppEventType } from "../../../shared/types.ts";
import { webhookFormatFor } from "../../../shared/webhooks.ts";
import { api, type Webhook, type WebhookDelivery, type WebhookFormat } from "../api.ts";
import { Card, Code } from "../components/Card.tsx";
import { Switch } from "../components/Switch.tsx";
import { Tip } from "../components/Tip.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { timeAgo } from "../lib/time.ts";
import { cx } from "../lib/util.ts";

const FORMAT: Record<WebhookFormat, { label: string; tip: string }> = {
  slack: { label: "Slack", tip: "Sent as a Slack message" },
  discord: { label: "Discord", tip: "Sent as a Discord message" },
  json: { label: "JSON", tip: "Signed JSON: verify X-Yaypost-Signature with the secret" },
};

/** The format the server will pick for this URL; null while it isn't a URL yet. */
function formatOf(url: string): WebhookFormat | null {
  try {
    return webhookFormatFor(url);
  } catch {
    return null;
  }
}

const eventsText = (events: AppEventType[]) =>
  events.length === APP_EVENT_TYPES.length ? "All events" : events.length <= 2 ? events.map((e) => EVENT_LABEL[e]).join(", ") : `${events.length} events`;

const ping = (r: { ok: boolean; status: number | null; error: string | null }, what: string) =>
  toast(r.ok ? { title: `${what} delivered (HTTP ${r.status})`, tone: "success" } : { title: `${what} failed`, description: r.error ?? undefined, tone: "error" });

export function Webhooks() {
  const qc = useQueryClient();
  const { data: hooks, isPending } = useQuery({ queryKey: ["webhooks"], queryFn: api.webhooks });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);

  return (
    <Card
      icon={<WebhookIcon size={16} />}
      title="Webhooks"
      action={
        !adding && (
          <Tip content="Post events to Slack, Discord, Zapier, n8n or your own service">
            <button onClick={() => setAdding(true)} className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-ink hover:bg-subtle">
              <Plus size={14} /> Add webhook
            </button>
          </Tip>
        )
      }
    >
      {(secret || adding || isPending || !!hooks?.length) && (
        <div className="space-y-3">
          {secret && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
              <p className="mb-2 text-sm font-medium text-amber-950 dark:text-amber-100">Save this signing secret now. It won't be shown again.</p>
              <Code label={secret.url} value={secret.secret} />
              <button onClick={() => setSecret(null)} className="mt-2 text-xs font-medium text-amber-900 underline dark:text-amber-200">
                I saved it
              </button>
            </div>
          )}

          {adding && (
            <AddWebhook
              onCancel={() => setAdding(false)}
              onCreated={(w) => {
                setAdding(false);
                // Chat formats aren't signed for the receiver to check: no secret to keep.
                if (w.format === "json") setSecret({ url: w.url, secret: w.secret });
                else toast({ title: `${FORMAT[w.format].label} webhook added`, description: "Send a test to see it arrive.", tone: "success" });
                void qc.invalidateQueries({ queryKey: ["webhooks"] });
              }}
            />
          )}

          {isPending ? (
            <LoaderCircle size={16} className="animate-spin text-ink-3" />
          ) : hooks?.length ? (
            <ul className="-mx-1 divide-y divide-line">
              {hooks.map((h) => (
                <HookRow key={h.id} hook={h} />
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** Events grouped the way you think about them; a group's name toggles the whole group. */
function EventPicker({ value, onChange }: { value: AppEventType[]; onChange: (events: AppEventType[]) => void }) {
  const has = new Set(value);
  const set = (types: AppEventType[], on: boolean) => {
    const next = new Set(value);
    types.forEach((t) => (on ? next.add(t) : next.delete(t)));
    onChange(APP_EVENT_TYPES.filter((t) => next.has(t)));
  };
  return (
    <div className="space-y-2.5">
      {EVENT_GROUPS.map((g) => {
        const types = g.events.map((e) => e.type);
        const all = types.every((t) => has.has(t));
        return (
          <div key={g.label} className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => set(types, !all)} aria-pressed={all} className="w-24 shrink-0 text-left text-xs font-medium text-ink-3 hover:text-ink">
              {g.label}
            </button>
            {g.events.map((e) => (
              <button
                type="button"
                key={e.type}
                aria-pressed={has.has(e.type)}
                title={e.type}
                onClick={() => set([e.type], !has.has(e.type))}
                className="h-7 rounded-full border border-line px-2.5 text-xs text-ink-3 transition-colors hover:border-line-strong aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-canvas"
              >
                {e.label}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function AddWebhook(p: { onCancel: () => void; onCreated: (w: Webhook & { secret: string }) => void }) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<AppEventType[]>(APP_EVENT_TYPES);
  const [choose, setChoose] = useState(false);
  const format = formatOf(url.trim());
  const create = useMutation({
    mutationFn: () => api.createWebhook(url.trim(), events.length === APP_EVENT_TYPES.length ? undefined : events),
    onSuccess: p.onCreated,
    onError: (e) => toastError("Couldn't add the webhook", e),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (format && events.length) create.mutate();
      }}
      className="space-y-3 rounded-xl border border-line bg-canvas p-3"
    >
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface pr-2 focus-within:border-line-strong">
        <input
          autoFocus
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hooks.slack.com/… or your endpoint"
          aria-label="Webhook URL"
          className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm text-ink outline-none"
        />
        {format && <FormatBadge format={format} />}
      </div>
      <div>
        <button
          type="button"
          onClick={() => setChoose((c) => !c)}
          aria-expanded={choose}
          className="flex items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink"
        >
          {eventsText(events)} <ChevronDown size={12} className={cx("transition-transform", choose && "rotate-180")} />
        </button>
        {choose && (
          <div className="mt-2.5">
            <EventPicker value={events} onChange={setEvents} />
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={p.onCancel} className="h-8 rounded-lg px-3 text-sm hover:bg-subtle">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!format || !events.length || create.isPending}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-sm font-medium text-canvas disabled:opacity-50"
        >
          {create.isPending && <LoaderCircle size={13} className="animate-spin" />} Add webhook
        </button>
      </div>
    </form>
  );
}

function FormatBadge({ format }: { format: WebhookFormat }) {
  return (
    <Tip content={FORMAT[format].tip}>
      <span className="shrink-0 cursor-help rounded-md bg-subtle px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{FORMAT[format].label}</span>
    </Tip>
  );
}

function HookRow({ hook }: { hook: Webhook }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["webhooks"] });
    void qc.invalidateQueries({ queryKey: ["webhook-deliveries", hook.id] });
  };
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateWebhook>[1]) => api.updateWebhook(hook.id, patch),
    onSuccess: (w) => qc.setQueryData<Webhook[]>(["webhooks"], (list) => list?.map((h) => (h.id === w.id ? w : h))),
    onError: (e) => toastError("Couldn't save the webhook", e),
  });
  const failing = hook.lastAt !== null && hook.lastError !== null;
  const u = (() => {
    try {
      const x = new URL(hook.url);
      return { host: x.host, path: x.pathname + x.search };
    } catch {
      return { host: hook.url, path: "" };
    }
  })();

  return (
    <li className={cx("px-3 py-2.5", !hook.enabled && "opacity-60")}>
      <div className="flex items-center gap-3">
        <Switch checked={hook.enabled} onChange={(enabled) => update.mutate({ enabled })} label={hook.enabled ? "Pause webhook" : "Resume webhook"} />
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs">
              <span className="text-ink">{u.host}</span>
              <span className="text-ink-3">{u.path}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-3">
              {FORMAT[hook.format].label} · {eventsText(hook.events)}
              {hook.lastAt && (
                <>
                  {" · "}
                  {failing ? (
                    <span className="truncate text-red-600 dark:text-red-400">{hook.lastError}</span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">HTTP {hook.lastStatus}</span>
                  )}
                  <span className="shrink-0">{timeAgo(hook.lastAt)}</span>
                </>
              )}
            </span>
          </span>
          <ChevronDown size={14} className={cx("shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && <HookDetails hook={hook} onSave={(patch) => update.mutate(patch)} saving={update.isPending} onDelivered={refresh} />}
    </li>
  );
}

function HookDetails(p: {
  hook: Webhook;
  onSave: (patch: Parameters<typeof api.updateWebhook>[1]) => void;
  saving: boolean;
  onDelivered: () => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(p.hook.url);
  const [confirm, setConfirm] = useState(false);
  const deliveries = useQuery({ queryKey: ["webhook-deliveries", p.hook.id], queryFn: () => api.webhookDeliveries(p.hook.id), refetchInterval: 15_000 });
  const test = useMutation({
    mutationFn: () => api.testWebhook(p.hook.id),
    onSuccess: (r) => (ping(r, "Test"), p.onDelivered()),
    onError: (e) => toastError("Couldn't send the test", e),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteWebhook(p.hook.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
    onError: (e) => toastError("Couldn't delete", e),
  });
  const urlChanged = url.trim() !== p.hook.url;
  const nextFormat = formatOf(url.trim());

  return (
    <div className="mt-3 space-y-4 pl-[52px]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (urlChanged && nextFormat) p.onSave({ url: url.trim() });
        }}
        className="flex items-center gap-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-canvas pr-2 focus-within:border-line-strong">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Webhook URL"
            className="h-8 min-w-0 flex-1 bg-transparent px-2.5 font-mono text-xs text-ink outline-none"
          />
          {nextFormat && <FormatBadge format={urlChanged ? nextFormat : p.hook.format} />}
        </div>
        {urlChanged && (
          <button type="submit" disabled={!nextFormat || p.saving} className="h-8 rounded-lg bg-ink px-3 text-xs font-medium text-canvas disabled:opacity-50">
            Save
          </button>
        )}
      </form>

      {/* Saved as you toggle; the last event can't be switched off (pause the webhook instead). */}
      <EventPicker value={p.hook.events} onChange={(events) => events.length && p.onSave({ events })} />

      <DeliveryLog hookId={p.hook.id} deliveries={deliveries.data} loading={deliveries.isPending} onDelivered={p.onDelivered} />

      <div className="flex items-center gap-2">
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending}
          className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs font-medium text-ink hover:bg-subtle"
        >
          {test.isPending ? <LoaderCircle size={12} className="animate-spin" /> : <Zap size={12} />} Send test
        </button>
        <button
          onClick={() => (confirm ? remove.mutate() : setConfirm(true))}
          onBlur={() => setConfirm(false)}
          aria-label="Delete webhook"
          className={cx(
            "ml-auto flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium",
            confirm ? "bg-red-600 text-white" : "text-ink-3 hover:bg-subtle hover:text-red-600",
          )}
        >
          <Trash2 size={13} /> {confirm && "Delete?"}
        </button>
      </div>
    </div>
  );
}

const pretty = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

function DeliveryLog(p: { hookId: string; deliveries: WebhookDelivery[] | undefined; loading: boolean; onDelivered: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (id: string) => api.resendDelivery(p.hookId, id),
    onSuccess: (r) => (ping(r, "Resend"), p.onDelivered()),
    onError: (e) => toastError("Couldn't resend", e),
  });
  if (p.loading) return <LoaderCircle size={14} className="animate-spin text-ink-3" />;
  if (!p.deliveries?.length) return <p className="text-xs text-ink-3">Nothing sent yet.</p>;
  return (
    <ul className="max-h-80 overflow-y-auto rounded-lg border border-line">
      {p.deliveries.map((d) => {
        const expanded = open === d.id;
        const pending = d.attempts === 0;
        return (
          <li key={d.id} className="border-b border-line last:border-0">
            <button onClick={() => setOpen(expanded ? null : d.id)} aria-expanded={expanded} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-subtle/60">
              {pending ? (
                <LoaderCircle size={12} className="shrink-0 animate-spin text-ink-3" />
              ) : d.ok ? (
                <CircleCheck size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <CircleAlert size={12} className="shrink-0 text-red-600 dark:text-red-400" />
              )}
              <span className="min-w-0 flex-1 truncate text-ink">{d.type === "ping" ? "Test" : (EVENT_LABEL[d.type as AppEventType] ?? d.type)}</span>
              <span className={cx("shrink-0 tabular-nums", d.ok ? "text-ink-3" : "text-red-600 dark:text-red-400")}>
                {pending ? "" : d.status ? `HTTP ${d.status}` : "No answer"}
                {d.attempts > 1 && ` · ${d.attempts} tries`}
              </span>
              <span className="w-16 shrink-0 text-right text-ink-3">{timeAgo(d.at)}</span>
            </button>
            {expanded && (
              <div className="space-y-2 bg-subtle/40 px-2.5 py-2">
                {d.error && <p className="text-xs break-words text-red-700 dark:text-red-300">{d.error}</p>}
                <pre className="max-h-48 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px] leading-relaxed text-ink">{pretty(d.body)}</pre>
                {d.response && (
                  <pre className="max-h-24 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px] leading-relaxed text-ink-2">{d.response}</pre>
                )}
                <button
                  onClick={() => resend.mutate(d.id)}
                  disabled={resend.isPending}
                  className="flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-subtle"
                >
                  {resend.isPending ? <LoaderCircle size={11} className="animate-spin" /> : <RotateCcw size={11} />} Resend
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
