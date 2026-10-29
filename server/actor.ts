// Who is acting in the current request or job. Set once per request (auth middleware) or job (operator, chat
// approvals); read wherever a decision depends on it (approval gate, audit log) without threading it through calls.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Actor {
  /** owner: the person (web UI, their chat approvals, owner token). agent: anything acting for them. */
  kind: "owner" | "agent" | "system";
  /** Surface: "ui", "api", "mcp", "cli", "operator", "telegram:@alice", "scheduler", … */
  via: string;
}

const store = new AsyncLocalStorage<Actor>();
const SYSTEM: Actor = { kind: "system", via: "scheduler" };

export const currentActor = (): Actor => store.getStore() ?? SYSTEM;
export const runAs = <T>(actor: Actor, fn: () => T): T => store.run(actor, fn);
export const actorLabel = (a: Actor = currentActor()) => `${a.kind}:${a.via}`;

export class ForbiddenError extends Error {
  status = 403;
}

/** Decisions only the person makes (approve, resume publishing, connect accounts…). */
export function requireOwner(what: string): void {
  if (currentActor().kind === "agent") {
    throw new ForbiddenError(`Only the person can ${what}. Agents ask; the person decides in the Yaypost UI, Telegram or Discord.`);
  }
}
