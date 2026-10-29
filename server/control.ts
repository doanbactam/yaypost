// Kill switch: one flag that stops every publish (scheduler and "publish now") until the person resumes.
// Anyone may pull the brake, an agent included; only the person releases it.
import type { PauseState } from "../shared/types.ts";
import { actorLabel, requireOwner } from "./actor.ts";
import { kv } from "./db.ts";
import { bus } from "./events.ts";
import { ConflictError } from "./repo.ts";

const KEY = "publishing.paused";

export const pauseState = (): PauseState | null => kv.get<PauseState | null>(KEY) ?? null;

export function pausePublishing(reason: string | null = null): PauseState {
  const current = pauseState();
  if (current) return current;
  const state: PauseState = { at: new Date().toISOString(), by: actorLabel(), reason: reason?.trim() || null };
  kv.set(KEY, state);
  bus.emit({ type: "publishing.paused", by: state.by, reason: state.reason });
  return state;
}

export function resumePublishing(): void {
  requireOwner("resume publishing");
  if (!pauseState()) return;
  kv.set(KEY, null);
  bus.emit({ type: "publishing.resumed", by: actorLabel(), reason: null });
}

export function assertNotPaused(): void {
  const p = pauseState();
  if (p) {
    throw new ConflictError(
      `Publishing is paused (by ${p.by}${p.reason ? `: ${p.reason}` : ""}). Nothing goes out until the person resumes it; scheduled posts wait.`,
    );
  }
}
