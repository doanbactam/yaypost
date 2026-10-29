// Connected accounts: list (handle, problems, re-check, character limit, remove) and the connect flow, whose form
// is generated from the credential fields each platform plugin declares (GET /api/platforms).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, ExternalLink, LoaderCircle, Plus, RefreshCw, Trash2, Users } from "lucide-react";
import { useState } from "react";
import type { Account, Post } from "../../../shared/types.ts";
import { api, ApiError, type Platform } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { Tip } from "../components/Tip.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Popover } from "../components/Popover.tsx";
import { toast, toastError } from "../components/Toasts.tsx";
import { limitFor, PlatformIcon, useAccounts, usePlatformList, usePlatforms } from "../lib/platforms.tsx";
import { navigate, openPost } from "../lib/router.ts";
import { timeAgo } from "../lib/time.ts";
import { cx } from "../lib/util.ts";

const field = "h-9 w-full rounded-lg border border-line bg-canvas px-3 text-sm text-ink placeholder:text-ink-3 focus:border-line-strong";
const smallBtn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-ink-2 hover:bg-subtle hover:text-ink disabled:opacity-50";

export function Accounts() {
  const { data: accounts, isPending } = useAccounts();
  const platforms = usePlatforms();
  // true opens the platform picker; a platform id opens that platform's form directly.
  const [connecting, setConnecting] = useState<boolean | string>(false);
  return (
    <Card
      icon={<Users size={16} />}
      title="Accounts"
     action={
        <button onClick={() => setConnecting(true)} className="flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-ink hover:bg-subtle">
          <Plus size={14} /> Connect account
        </button>
      }
    >
      {isPending ? (
        <LoaderCircle size={16} className="animate-spin text-ink-3" />
      ) : accounts?.length ? (
        <ul className="-mx-1 divide-y divide-line">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </ul>
      ) : (
        // No accounts: the platforms you can connect, each one a way in.
        <div className="flex flex-wrap gap-1.5">
          {platforms.list.map((pl) => (
            <Tip key={pl.id} content={`Connect ${pl.name}`}>
              <button
                onClick={() => setConnecting(pl.id)}
                aria-label={`Connect ${pl.name}`}
                className="grid size-9 place-items-center rounded-lg border border-dashed border-line-strong text-ink-2 hover:border-solid hover:text-ink"
              >
                <PlatformIcon platform={pl.id} size={16} />
              </button>
            </Tip>
          ))}
        </div>
      )}
      {connecting && <ConnectDialog initial={typeof connecting === "string" ? connecting : undefined} onClose={() => setConnecting(false)} />}
    </Card>
  );
}

/** Posts that haven't fully gone out and still list this account as a destination (why removing it is refused). */
async function blockingPosts(accountId: string): Promise<Post[]> {
  try {
    const posts = await api.listPosts({ status: ["draft", "scheduled", "due", "failed", "publishing"], limit: 200 });
    return posts.filter((p) => p.targets.some((t) => t.accountId === accountId && t.status !== "published"));
  } catch {
    return [];
  }
}

function AccountRow({ account: a }: { account: Account }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const check = useMutation({
    mutationFn: () => api.checkAccount(a.id),
    onSuccess: (r) => {
      void refresh();
      if (r.lastError) toast({ title: `${r.label} needs attention`, description: r.lastError, tone: "error" });
      else toast({ title: `${r.label} is working`, tone: "success" });
    },
    onError: (e) => toastError("Couldn't check the account", e),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAccount(a.id),
    onSuccess: () => {
      void refresh();
      toast({ title: `Removed ${a.label}` });
    },
    onError: (e) => {
      setConfirm(false);
      if (!(e instanceof ApiError && e.status === 409)) return toastError(`Couldn't remove ${a.label}`, e);
      // Blocked by posts that still go to it: point at them so they can be changed (or finished) first.
      void blockingPosts(a.id).then((posts) => {
        const first = posts[0];
        toast({
          title: `Couldn't remove ${a.label}`,
          description: e.message,
          tone: "error",
          duration: 15_000,
          actions: [
            ...(first ? [{ label: posts.length > 1 ? `Open the first of ${posts.length}` : "Open that post", primary: true, onClick: () => openPost(first.id) }] : []),
            { label: "View queue", onClick: () => navigate("/queue") },
          ],
        });
      });
    },
  });
  const platforms = usePlatforms();
  return (
    <li className="group flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-subtle text-ink">
        <PlatformIcon platform={a.platform} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
          <span className="font-medium text-ink">{a.label}</span>
          {a.handle &&
            (a.profileUrl ? (
              <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-ink-2 hover:text-ink hover:underline">
                {a.handle} <ExternalLink size={11} />
              </a>
            ) : (
              <span className="text-ink-2">{a.handle}</span>
            ))}
        </p>
        <p className="text-xs text-ink-3">
          {platforms.name(a.platform)} · <LimitEditor account={a} />
          {a.verifiedAt && ` · checked ${timeAgo(a.verifiedAt)}`}
        </p>
        {a.lastError && (
          <p className="mt-1 flex items-start gap-1 text-xs break-words text-red-700 dark:text-red-300">
            <CircleAlert size={12} className="mt-0.5 shrink-0" /> {a.lastError}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 max-sm:w-full max-sm:pl-10">
        <Tip content="Check the credentials">
          <button onClick={() => check.mutate()} disabled={check.isPending} aria-label={`Check ${a.label}`} className={smallBtn}>
            {check.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        </Tip>
        <button
          onClick={() => (confirm ? remove.mutate() : setConfirm(true))}
          onBlur={() => setConfirm(false)}
          disabled={remove.isPending}
          aria-label={confirm ? `Confirm removing ${a.label}` : `Remove ${a.label}`}
          className={cx(smallBtn, confirm ? "bg-red-600 text-white hover:bg-red-700 hover:text-white" : "hover:text-red-600")}
        >
          <Trash2 size={13} /> {confirm && "Remove"}
        </button>
      </div>
    </li>
  );
}

/** "300 characters" with a small editor for the per-account override (X Premium, an instance's own limit). */
function LimitEditor({ account: a }: { account: Account }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(a.maxChars ? String(a.maxChars) : "");
  const platforms = usePlatforms();
  const fallback = limitFor({ ...a, maxChars: null }, platforms);
  const save = useMutation({
    mutationFn: (maxChars: number | null) => api.updateAccount(a.id, { maxChars }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      setOpen(false);
    },
    onError: (e) => toastError("Couldn't change the limit", e),
  });
  return (
    <Popover
      trigger={
        <button className="underline decoration-dotted underline-offset-2 hover:text-ink">
          {limitFor(a, platforms)} characters{a.maxChars ? " (custom)" : ""}
        </button>
      }
      open={open}
      onOpenChange={setOpen}
      className="w-64"
    >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(value.trim() ? Number(value) : null);
          }}
          className="space-y-2 text-ink"
        >
          <label className="block text-xs font-medium text-ink-2">
            Character limit
            <input autoFocus type="number" min={1} value={value} onChange={(e) => setValue(e.target.value)} placeholder={String(fallback)} className={cx(field, "mt-1")} />
          </label>
          <button type="submit" disabled={save.isPending} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-ink text-sm font-medium text-canvas">
            {save.isPending && <LoaderCircle size={13} className="animate-spin" />} Save
          </button>
        </form>
    </Popover>
  );
}

function ConnectDialog({ initial, onClose }: { initial?: string; onClose: () => void }) {
  const { data: list, isPending, error } = usePlatformList();
  const [picked, setPlatform] = useState<Platform | null>(null);
  const [skipInitial, setSkipInitial] = useState(false);
  const platform = picked ?? (skipInitial ? null : (list?.find((p) => p.id === initial) ?? null));
  return (
    <Dialog title={platform ? `Connect ${platform.name}` : "Connect an account"} onClose={onClose}>
      {platform ? (
        <ConnectForm key={platform.id} info={platform} onBack={() => (setPlatform(null), setSkipInitial(true))} onDone={onClose} />
      ) : isPending ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-[86px] animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-red-600">{error.message}</p>
      ) : !list.length ? (
        <p className="text-sm text-ink-3">No platform plugins are loaded.</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => setPlatform(p)}
              className="flex flex-col items-start gap-2 rounded-xl border border-line bg-canvas p-3 text-left hover:border-line-strong"
            >
              <PlatformIcon platform={p.id} size={18} />
              <span>
                <span className="block text-sm font-medium">{p.name}</span>
                <span className="block text-xs text-ink-3">{p.costNote.startsWith("Free") ? "Free" : "Paid API"}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function ConnectForm({ info, onBack, onDone }: { info: Platform; onBack: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const platform = info.id;
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState("");
  const [maxChars, setMaxChars] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () =>
      api.connectAccount({
        platform,
        credentials: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim())),
        label: label.trim() || undefined,
        maxChars: maxChars.trim() ? Number(maxChars) : undefined,
      }),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ["accounts"] });
      toast({ title: `Connected ${a.label}`, description: a.handle ?? undefined, tone: "success" });
      onDone();
    },
    // The platform's own reason (bad token, wrong instance…) belongs next to the fields, not in a toast.
    onError: (e) => (e instanceof ApiError && e.status === 400 ? setError(e.message) : toastError("Couldn't connect", e)),
  });
  const fallback = info.maxChars;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        connect.mutate();
      }}
      className="space-y-3 text-sm"
    >
      <p className="text-xs leading-relaxed text-ink-2">{info.setup}</p>
      <p className={cx("rounded-lg px-2.5 py-1.5 text-xs", info.costNote.startsWith("Free") ? "bg-subtle text-ink-2" : "bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200")}>
        {info.costNote}
      </p>
      {info.credentials.map((f, i) => (
        <label key={f.key} className="block">
          <span className="text-xs font-medium text-ink-2">
            {f.label}
            {f.optional && <span className="font-normal text-ink-3"> (optional)</span>}
          </span>
          <input
            autoFocus={i === 0}
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            spellCheck={false}
            required={!f.optional}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            placeholder={f.placeholder}
            className={cx(field, "mt-1 font-mono text-[13px]")}
          />
          {f.help && <span className="mt-0.5 block text-xs text-ink-3">{f.help}</span>}
        </label>
      ))}
      <div className="grid grid-cols-[1fr_8rem] gap-2">
        <label className="block">
          <span className="text-xs font-medium text-ink-2">
            Name <span className="font-normal text-ink-3">(optional)</span>
          </span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Defaults to the handle" className={cx(field, "mt-1")} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink-2">Char limit</span>
          <input type="number" min={1} value={maxChars} onChange={(e) => setMaxChars(e.target.value)} placeholder={String(fallback)} className={cx(field, "mt-1")} />
        </label>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-xs break-words text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          <CircleAlert size={13} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onBack} className="flex h-9 items-center gap-1 rounded-lg px-2.5 text-ink-2 hover:bg-subtle hover:text-ink">
          <ArrowLeft size={14} /> Platforms
        </button>
        <button type="submit" disabled={connect.isPending} className="flex h-9 items-center gap-1.5 rounded-lg bg-ink px-3.5 font-medium text-canvas hover:opacity-90 disabled:opacity-50">
          {connect.isPending && <LoaderCircle size={14} className="animate-spin" />}
          {connect.isPending ? "Checking with " + info.name + "…" : `Connect ${info.name}`}
        </button>
      </div>
    </form>
  );
}
