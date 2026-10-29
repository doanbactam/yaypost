// Registry the command palette reads: views register the actions that make sense while they are mounted.
import type { LucideIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

export interface Command {
  id: string;
  title: string;
  group: string;
  icon?: LucideIcon;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

const sources = new Map<string, Command[]>();
let all: Command[] = [];
const listeners = new Set<() => void>();

function rebuild() {
  all = [...sources.values()].flat();
  listeners.forEach((l) => l());
}

/** Register commands for as long as the calling component is mounted. Pass a memoized array. */
export function useCommands(source: string, commands: Command[]) {
  useEffect(() => {
    sources.set(source, commands);
    rebuild();
    return () => {
      sources.delete(source);
      rebuild();
    };
  }, [source, commands]);
}

export function useAllCommands(): Command[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => all,
  );
}
