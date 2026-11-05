// Publishing through the real plugin path with a fake platform (test/fixtures/fake-platform): limits are checked
// before anything goes out, one destination failing doesn't stop the others, and Retry resumes without duplicates.
import { beforeAll, describe, expect, test } from "vitest";
import type { Account } from "../shared/types.ts";
import { fakeState } from "./fixtures/fake-platform/index.ts";
import { useTempServer } from "./setup.ts";

useTempServer();
const { loadPlugins } = await import("../server/plugins.ts");
const { connectAccount, getAccount } = await import("../server/accounts.ts");
const { createPost, requirePost } = await import("../server/repo.ts");
const { publishNow, retryPost } = await import("../server/scheduler.ts");
const { preflight } = await import("../server/publisher.ts");

beforeAll(() => loadPlugins());

const fake = fakeState();
const connect = (name: string) => connectAccount({ platform: "fake", credentials: { name } });
const target = (postId: string, accountId: string) => requirePost(postId).targets.find((t) => t.accountId === accountId)!;
/** An account of a built-in platform, for preflight only (connecting one would call its API). */
const offline = (platform: string) => ({ id: platform, platform, label: platform, maxChars: null }) as unknown as Account;
const item = (text: string) => ({ text, mediaIds: [] });

describe("preflight: both sides of each platform's limit", () => {
  test("X: 280 weighted, a URL is 23", () => {
    expect(preflight(offline("x"), [item("ạ".repeat(140))])).toBeNull();
    expect(preflight(offline("x"), [item("ạ".repeat(141))])).toMatch(/282\/280/);
    const url = "https://example.com/" + "a".repeat(60);
    expect(preflight(offline("x"), [item(`${"a".repeat(256)} ${url}`)])).toBeNull();
    expect(preflight(offline("x"), [item(`${"a".repeat(257)} ${url}`)])).toMatch(/281\/280/);
  });
  test("Bluesky: 300 graphemes", () => {
    expect(preflight(offline("bluesky"), [item("👨‍👩‍👧".repeat(300))])).toBeNull();
    expect(preflight(offline("bluesky"), [item("👨‍👩‍👧".repeat(301))])).toMatch(/301\/300/);
  });
  test("an account's own limit wins, and the failing post of a thread is named", () => {
    const own = { ...offline("mastodon"), maxChars: 20 } as Account;
    expect(preflight(own, [item("ok"), item("x".repeat(21))])).toMatch(/^Post 2 is 21\/20/);
  });
});

test("a destination over its limit fails before anything is posted there; the others still publish", async () => {
  const short = await connect("short");
  const other = await connect("other-short");
  const post = createPost({
    thread: [item("fits"), item("far too long for ten")],
    targets: [{ accountId: short.id }, { accountId: other.id, thread: [item("fits"), item("also fits")] }],
    source: "ui",
  });
  const after = await publishNow(post.id);
  expect(after.status).toBe("failed");
  expect(fake.received.short).toBeUndefined();
  expect(target(post.id, short.id).status).toBe("failed");
  expect(fake.received["other-short"]).toEqual(["fits", "also fits"]);
});

test("Retry after item 2 of 3 failed posts only items 2 and 3, once", async () => {
  const bob = await connect("bob");
  const post = createPost({ text: "one\n---\ntwo\n---\nthree", targets: [{ accountId: bob.id }], source: "ui" });
  fake.failNext.bob = { at: 1, status: 503 };

  const failed = await publishNow(post.id);
  expect(failed.status).toBe("failed");
  expect(target(post.id, bob.id).externalIds).toHaveLength(1);
  expect(failed.error).toMatch(/1 of 3 is live/);
  expect(getAccount(bob.id).lastError).toBeNull(); // a 503 is the platform's problem, not the account's

  const retried = await retryPost(post.id);
  expect(retried.status).toBe("published");
  expect(fake.received.bob).toEqual(["one", "two", "three"]);
  expect(target(post.id, bob.id).externalIds).toEqual(["bob-1", "bob-2", "bob-3"]);
});

test("one destination failing with 401 flags its account, doesn't stop the other, and Retry doesn't repost the other", async () => {
  const alice = await connect("alice");
  const carol = await connect("carol");
  const post = createPost({ text: "hello\n---\nagain", targets: [{ accountId: alice.id }, { accountId: carol.id }], source: "ui" });
  fake.failNext.alice = { at: 0, status: 401 };

  const failed = await publishNow(post.id);
  expect(failed.status).toBe("failed");
  expect(target(post.id, carol.id).status).toBe("published");
  expect(fake.received.carol).toEqual(["hello", "again"]);
  expect(getAccount(alice.id).lastError).toMatch(/fake failure/);

  const retried = await retryPost(post.id);
  expect(retried.status).toBe("published");
  expect(fake.received.alice).toEqual(["hello", "again"]);
  expect(fake.received.carol).toEqual(["hello", "again"]);
  expect(getAccount(alice.id).lastError).toBeNull();
});
