// X-style progress ring for the strictest destination's count; shows what's left near the limit and −N over it.
import { cx } from "../lib/util.ts";

/** `platform` names the destination the ring measures. */
export function CharRing({ length, max, platform, named }: { length: number; max: number; platform: string; named?: boolean }) {
  const left = max - length;
  const near = left <= Math.min(20, Math.round(max * 0.08));
  const over = left < 0;
  const r = 9;
  const c = 2 * Math.PI * r;
  const progress = Math.min(length / max, 1);
  return (
    <div
      className="flex items-center gap-1.5 tabular-nums"
      title={`${length} / ${max} characters on ${platform}`}
      aria-label={over ? `${-left} characters over the ${platform} limit` : `${left} characters left on ${platform}`}
    >
      {near && (
        <span className={cx("text-xs font-medium", over ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")}>
          {over && named ? `${platform} −${-left}` : over ? `−${-left}` : left}
        </span>
      )}
      <svg width="22" height="22" viewBox="0 0 22 22" className={cx("-rotate-90 transition-transform", near && "scale-110")}>
        <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2" className="stroke-line-strong opacity-60" />
        {length > 0 && (
          <circle
            cx="11"
            cy="11"
            r={r}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - progress)}
            className={cx(
              "transition-[stroke-dashoffset] duration-150",
              over ? "stroke-red-500" : near ? "stroke-amber-500" : "stroke-sky-500",
            )}
          />
        )}
      </svg>
    </div>
  );
}
