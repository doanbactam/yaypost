// In-process event bus. The repo emits; SSE, webhooks and push notifications listen.
import { EventEmitter } from "node:events";
import type { AppEvent } from "../shared/types.ts";

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const bus = {
  emit(event: AppEvent) {
    emitter.emit("event", event);
  },
  on(listener: (event: AppEvent) => void): () => void {
    emitter.on("event", listener);
    return () => emitter.off("event", listener);
  },
};
