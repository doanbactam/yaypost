// Small browser helpers: ids that work outside secure contexts, clipboard with fallbacks, platform keys.

export function uid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function legacyCopy(text: string) {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(el);
  el.select();
  const ok = document.execCommand("copy");
  el.remove();
  if (!ok) throw new Error("Clipboard is blocked by the browser");
}

/**
 * Copies text that may still be loading. Call synchronously from a click/keypress: Safari only allows
 * clipboard writes inside the gesture, which ClipboardItem-with-a-promise preserves across the fetch.
 */
export async function copyText(source: string | Promise<string>): Promise<void> {
  if (typeof source !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const blob = source.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // fall through to writeText
    }
  }
  const text = await source;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    legacyCopy(text);
  }
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Shortcut labels as each platform writes them. */
export const keys = {
  queue: isMac ? "⌘↵" : "Ctrl+Enter",
  copy: isMac ? "⌘⇧C" : "Ctrl+Shift+C",
  palette: isMac ? "⌘K" : "Ctrl+K",
  undo: isMac ? "⌘Z" : "Ctrl+Z",
};

/** First non-empty line, trimmed — used as a draft's title. */
export function firstLine(text: string, max = 80): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
