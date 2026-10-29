// Weekday specs as yaypost.config.json writes them ("mon-fri", "sat,sun", "daily"), shared by the server's
// validation and scheduling and the app's day pickers.

const NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "mon-fri", "fri-mon", "sat,sun", "daily", "weekdays", "weekends" → JS day numbers (0 = Sunday); null if unparseable. */
export function parseDays(spec: string): Set<number> | null {
  const out = new Set<number>();
  const day = (d: string) => (d.length >= 3 ? NAMES.findIndex((n) => n.startsWith(d)) : -1);
  for (const part of spec.toLowerCase().split(",").map((s) => s.trim())) {
    if (part === "daily" || part === "*") NAMES.forEach((_, i) => out.add(i));
    else if (part === "weekdays") [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (part === "weekends") [0, 6].forEach((d) => out.add(d));
    else if (part.includes("-")) {
      const [a, b, extra] = part.split("-").map((d) => day(d.trim()));
      if (a === undefined || b === undefined || extra !== undefined || a < 0 || b < 0) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === b) break;
      }
    } else {
      const d = day(part);
      if (d < 0) return null;
      out.add(d);
    }
  }
  return out.size ? out : null;
}

/** Day numbers → the spec a person would write: "daily", "mon-fri", "sat,sun", or names Monday first. */
export function daysSpec(days: number[]): string {
  const set = [...new Set(days)].sort();
  const key = set.join();
  if (set.length === 7) return "daily";
  if (key === "1,2,3,4,5") return "mon-fri";
  if (key === "0,6") return "sat,sun";
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => set.includes(d))
    .map((d) => NAMES[d]!.slice(0, 3))
    .join(",");
}
