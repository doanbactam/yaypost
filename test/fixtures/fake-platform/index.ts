// A platform for tests: it records what each account "posted" and fails on demand, so tests can check that a
// thread resumes after a failure without posting anything twice. Tests reach its state through globalThis.
import type { PlatformDefinition, YaypostAPI } from "yaypost/plugin";

export interface FakeState {
  /** Texts each account (by its `name` credential) received, in order; a duplicate shows up twice. */
  received: Record<string, string[]>;
  /** The next publish to this account fails at item `at` (0-based); cleared once it fires. */
  failNext: Record<string, { at: number; status?: number; resumable?: boolean }>;
}

export const fakeState = (): FakeState =>
  ((globalThis as { __yaypostFake?: FakeState }).__yaypostFake ??= { received: {}, failNext: {} });

export default function fake(ts: YaypostAPI): void {
  const platform: PlatformDefinition = {
    id: "fake",
    name: "Fake",
    maxChars: 10,
    maxImages: 4,
    threadMode: "replies",
    counting: { method: "codepoints" },
    costNote: "Test only.",
    setup: "Test only.",
    credentials: [{ key: "name", label: "Name", secret: false }],
    async verify(credentials) {
      return { handle: credentials.name!, profileUrl: null };
    },
    async publish(ctx) {
      const state = fakeState();
      const name = ctx.credentials.name!;
      const received = (state.received[name] ??= []);
      const ids = [...ctx.posted];
      for (let i = ids.length; i < ctx.items.length; i++) {
        const fail = state.failNext[name];
        if (fail && fail.at === i) {
          delete state.failNext[name];
          throw new ts.PlatformError(`fake failure on item ${i + 1}`, fail.status, fail.resumable ?? true);
        }
        received.push(ctx.items[i]!.text);
        ids.push(`${name}-${received.length}`);
        ctx.record(ids);
      }
      return { ids, url: `https://fake.example/${name}/${ids[0]}` };
    },
  };
  ts.registerPlatform(platform);
}
