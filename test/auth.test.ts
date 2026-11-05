// The gate over HTTP: with AUTH_TOKEN and AGENT_TOKEN set, an agent can't approve its own post or resume
// publishing, and the operator counts as an agent whatever token it holds.
import { beforeAll, expect, test } from "vitest";
import { inMinutes, useTempServer } from "./setup.ts";

const OWNER = "owner-token-for-tests";
const AGENT = "agent-token-for-tests";
useTempServer({ AUTH_TOKEN: OWNER, AGENT_TOKEN: AGENT });
const { app } = await import("../server/app.ts");
const { loadPlugins } = await import("../server/plugins.ts");
const { connectAccount } = await import("../server/accounts.ts");
const { requirePost } = await import("../server/repo.ts");

let accountId = "";
beforeAll(async () => {
  await loadPlugins();
  accountId = (await connectAccount({ platform: "fake", credentials: { name: "http" } })).id;
});

const call = (path: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function agentPost(): Promise<string> {
  const res = await call("/posts", AGENT, { text: "from the agent", targets: [{ accountId }], scheduledAt: inMinutes(30) });
  expect(res.status).toBe(201);
  const post = (await res.json()) as { id: string; approval: { state: string } | null };
  expect(post.approval?.state).toBe("pending");
  return post.id;
}

test("the agent token can't approve; the owner token can", async () => {
  const id = await agentPost();
  expect((await call(`/posts/${id}/approve`, AGENT, {})).status).toBe(403);
  expect(requirePost(id).approval?.state).toBe("pending");
  expect((await call(`/posts/${id}/approve`, OWNER, {})).status).toBe(200);
  expect(requirePost(id).approval?.state).toBe("approved");
});

test("the operator is an agent even with the owner token", async () => {
  const id = await agentPost();
  expect((await call(`/posts/${id}/approve`, OWNER, {}, { "x-yaypost-source": "operator" })).status).toBe(403);
  expect(requirePost(id).approval?.state).toBe("pending");
});

test("the agent token can pause but not resume", async () => {
  expect((await call("/control/pause", AGENT, { reason: "test" })).status).toBe(200);
  expect((await call("/control/resume", AGENT, {})).status).toBe(403);
  expect((await call("/control/resume", OWNER, {})).status).toBe(200);
});

test("no token, no access", async () => {
  expect((await app.request("/api/posts")).status).toBe(401);
});
