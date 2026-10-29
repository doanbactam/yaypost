// Shown when the server has AUTH_TOKEN set and we don't have (the right) token yet.
import { KeyRound, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { auth } from "../api.ts";
import { Logo } from "./Sidebar.tsx";

export function TokenPrompt({ retry, rejected }: { retry: () => Promise<unknown>; rejected: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-full place-items-center p-4">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!token.trim()) return;
          setBusy(true);
          auth.set(token.trim());
          await retry();
          setBusy(false);
        }}
        className="w-full max-w-sm animate-rise rounded-2xl border border-line bg-surface p-6 shadow-sm"
      >
        <Logo />
        <h1 className="mt-4 text-lg font-semibold tracking-tight">This Yaypost is protected</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          Enter the <code className="font-mono text-xs">AUTH_TOKEN</code> from the server's <code className="font-mono text-xs">.env</code>. It stays
          in this browser.
        </p>
        <label className="mt-5 flex items-center gap-2 rounded-xl border border-line bg-canvas px-3 focus-within:border-line-strong">
          <KeyRound size={16} className="text-ink-3" />
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Token"
            aria-label="Access token"
            className="h-11 flex-1 bg-transparent text-sm"
          />
        </label>
        {rejected && auth.token && !busy && <p className="mt-2 text-sm text-red-600 dark:text-red-400">That token wasn't accepted.</p>}
        <button
          type="submit"
          disabled={busy || !token.trim()}
          className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-ink text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-50"
        >
          {busy && <LoaderCircle size={15} className="animate-spin" />} Continue
        </button>
      </form>
    </div>
  );
}
