// GET /api/events: the event bus as Server-Sent Events (event name = AppEvent type, data = the AppEvent as JSON).
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bus } from "./events.ts";

const KEEPALIVE_MS = 25_000;

export function eventStream(c: Context): Response {
  c.header("X-Accel-Buffering", "no"); // keep nginx & co. from buffering the stream
  return streamSSE(c, async (stream) => {
    // Serialize writes so events never interleave on the wire.
    let chain: Promise<unknown> = Promise.resolve();
    const send = (write: () => Promise<unknown>) => (chain = chain.then(write).catch(() => {}));

    const done = new Promise<void>((resolve) => stream.onAbort(resolve));
    const off = bus.on((event) => send(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })));
    const ping = setInterval(() => send(() => stream.write(": ping\n\n")), KEEPALIVE_MS);
    send(() => stream.write(": connected\n\n"));

    await done;
    off();
    clearInterval(ping);
  });
}
