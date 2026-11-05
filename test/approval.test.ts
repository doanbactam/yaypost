// The approval gate: what an agent queues or publishes waits for the person; changing approved content asks again;
// agents can pull the brake but only the person releases it.
import { beforeAll, expect, test } from "vitest";
import type { Actor } from "../server/actor.ts";
import { fakeState } from "./fixtures/fake-platform/index.ts";
import { inMinutes, useTempServer } from "./setup.ts";

useTempServer();
const { loadPlugins } = await import("../server/plugins.ts");
const { connectAccount } = await import("../server/accounts.ts");
const { runAs, ForbiddenError } = await import("../server/actor.ts");
const repo = await import("../server/repo.ts");
const { publishNow } = await import("../server/scheduler.ts");
const control = await import("../server/control.ts");

const agent: Actor = { kind: "agent", via: "mcp" };
const owner: Actor = { kind: "owner", via: "ui" };
const fake = fakeState();
let accountId = "";

beforeAll(async () => {
  await loadPlugins();
  accountId = (await connectAccount({ platform: "fake", credentials: { name: "gated" } })).id;
});

/** The post the scheduler would pick up if it ran an hour from now, if any. */
const claimable = () => repo.claimNextDuePost(new Date(Date.now() + 3_600_000));

test("an agent's scheduled post waits for the person, then goes out once approved", () => {
  const post = runAs(agent, () => repo.createPost({ text: "hi", scheduledAt: inMinutes(5), targets: [{ accountId }], source: "mcp" }));
  expect(post.approval?.state).toBe("pending");
  expect(claimable()).toBeUndefined();

  runAs(owner, () => repo.decide(post.id, "approve"));
  expect(claimable()?.id).toBe(post.id);
});

test("an agent's publish now publishes nothing and asks the person instead", async () => {
  const post = runAs(agent, () => repo.createPost({ text: "now", targets: [{ accountId }], source: "mcp" }));
  const after = await runAs(agent, () => publishNow(post.id));
  expect(after.status).toBe("scheduled");
  expect(after.approval?.state).toBe("pending");
  expect(fake.received.gated ?? []).not.toContain("now");
  // Asking again doesn't get it out either.
  await expect(runAs(agent, () => publishNow(post.id))).rejects.toThrow(/waiting for the person's approval/);
});

test("an agent changing approved content asks again; the person's own edit doesn't", () => {
  const post = runAs(agent, () => repo.createPost({ text: "v1", scheduledAt: inMinutes(60 * 24), targets: [{ accountId }], source: "mcp" }));
  runAs(owner, () => repo.decide(post.id, "approve"));

  expect(runAs(owner, () => repo.updatePost(post.id, { text: "v2" })).approval?.state).toBe("approved");
  expect(runAs(agent, () => repo.updatePost(post.id, { title: "only a title" })).approval?.state).toBe("approved");
  expect(runAs(agent, () => repo.updatePost(post.id, { text: "v3" })).approval?.state).toBe("pending");
});

test("an agent continuing a published thread asks again", async () => {
  const post = runAs(owner, () => repo.createPost({ text: "first", targets: [{ accountId }], source: "ui" }));
  expect((await runAs(owner, () => publishNow(post.id))).status).toBe("published");
  const appended = runAs(agent, () => repo.appendToPost(post.id, { text: "more" }, null));
  expect(appended.approval?.state).toBe("pending");
  expect(claimable()?.id).not.toBe(post.id);
});

test("an agent can pause publishing but only the person can resume it", async () => {
  runAs(agent, () => control.pausePublishing("looks wrong"));
  expect(() => runAs(agent, () => control.resumePublishing())).toThrow(ForbiddenError);
  expect(control.pauseState()?.by).toBe("agent:mcp");

  const post = runAs(owner, () => repo.createPost({ text: "held", targets: [{ accountId }], source: "ui" }));
  await expect(runAs(owner, () => publishNow(post.id))).rejects.toThrow(/paused/);

  runAs(owner, () => control.resumePublishing());
  expect(control.pauseState()).toBeNull();
});
