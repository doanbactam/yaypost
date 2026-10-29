// REST for the person's side: approvals, the kill switch, the audit log, the digest and the approval chats.
// Mounted at /api. Deciding and resuming need the owner (see server/actor.ts); agents can read and pause.
import { createRoute, z } from "@hono/zod-openapi";
import type { ControlState } from "../shared/types.ts";
import { currentActor, requireOwner } from "./actor.ts";
import { PostSchema } from "./api.ts";
import { forgetFeedback, listAudit, listFeedback, restoreFeedback } from "./audit.ts";
import { getConfig } from "./config.ts";
import { pausePublishing, pauseState, resumePublishing } from "./control.ts";
import { createRouter } from "./http.ts";
import { digestText } from "./notify/card.ts";
import { channelStatuses, sendDigest, testChannels } from "./notify/hub.ts";
import { decide, listAwaiting, NotFoundError } from "./repo.ts";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T, required = true) => ({ required, content: { "application/json": { schema } } });
const Err = z.object({ error: z.string(), message: z.string() });
const E403 = json(Err, "Only the person (owner) can do this; agents get 403.");
const E409 = json(Err, "Not waiting for a decision (already decided, withdrawn, or never asked).");
const IdParam = z.object({ id: z.string() });
const tags = ["Approvals"];

const PauseSchema = z.object({ at: z.iso.datetime(), by: z.string(), reason: z.string().nullable() }).openapi("PauseState");
const ChannelSchema = z
  .object({ id: z.string(), name: z.string(), configured: z.boolean(), connected: z.boolean(), error: z.string().nullable() })
  .openapi("ChannelStatus");
const ControlSchema = z
  .object({
    paused: PauseSchema.nullable(),
    approval: z.object({ require: z.enum(["agents", "never"]), except: z.array(z.string()) }),
    role: z.enum(["owner", "agent"]),
    channels: z.array(ChannelSchema),
    pendingApprovals: z.number().int(),
  })
  .openapi("ControlState");
const AuditSchema = z
  .object({ id: z.number().int(), at: z.iso.datetime(), actor: z.string(), action: z.string(), postId: z.string().nullable(), detail: z.string().nullable() })
  .openapi("AuditEntry");

export function controlState(): ControlState {
  const { approval } = getConfig();
  return {
    paused: pauseState(),
    approval,
    role: currentActor().kind === "agent" ? "agent" : "owner",
    channels: channelStatuses(),
    pendingApprovals: listAwaiting().filter((p) => p.approval?.state === "pending").length,
  };
}

export const controlRoutes = createRouter();

controlRoutes.openapi(
  createRoute({
    method: "get",
    path: "/control",
    tags,
    operationId: "getControl",
    summary: "Approval policy, kill switch, approval chats",
    description: "What governs publishing right now: whether it is paused, which agent posts need approval and which chats are connected.",
    responses: { 200: json(ControlSchema, "Current state.") },
  }),
  (c) => c.json(controlState(), 200),
);

controlRoutes.openapi(
  createRoute({
    method: "get",
    path: "/approvals",
    tags,
    operationId: "listApprovals",
    summary: "Posts waiting for the person, or sent back for changes",
    description:
      "approval.state pending: waiting for the person's decision. changes_requested: the person wants changes (approval.note); revise the post with " +
      "PATCH /posts/{id}, which asks again. Neither is ever published.",
    responses: { 200: json(z.object({ posts: z.array(PostSchema) }), "Waiting posts, oldest request first.") },
  }),
  (c) => c.json({ posts: listAwaiting() }, 200),
);

const NoteBody = z.object({ note: z.string().max(2000).optional().openapi({ description: "Optional note, kept with the decision." }) });

for (const [path, decision, summary, description] of [
  ["approve", "approve", "Approve a post", "It goes out at its scheduled time, or right away if that has passed (unless publishing is paused)."],
  ["reject", "reject", "Reject a post", "Back to drafts, with the optional note as the reason."],
  [
    "request-changes",
    "request_changes",
    "Send a post back with feedback",
    "Stays queued but blocked; `note` (required) tells the agent what to change. The agent's revision asks again.",
  ],
] as const) {
  controlRoutes.openapi(
    createRoute({
      method: "post",
      path: `/posts/{id}/${path}`,
      tags,
      operationId: `${decision === "request_changes" ? "requestChanges" : decision}Post`,
      summary,
      description: `${description} Only the person (owner) can decide; agents get 403.`,
      request: { params: IdParam, body: body(NoteBody, decision === "request_changes") },
      responses: { 200: json(PostSchema, "The post after the decision."), 403: E403, 404: json(Err, "Not found."), 409: E409 },
    }),
    async (c) => {
      requireOwner("approve, reject or send back posts");
      const note = (await c.req.json().catch(() => ({})) as { note?: string }).note ?? null;
      return c.json(decide(c.req.valid("param").id, decision, note), 200);
    },
  );
}

controlRoutes.openapi(
  createRoute({
    method: "post",
    path: "/control/pause",
    tags,
    operationId: "pausePublishing",
    summary: "Stop all publishing (kill switch)",
    description: "Nothing is published until the person resumes: scheduled posts wait, publish now is refused. Anyone may pause, agents included.",
    request: { body: body(z.object({ reason: z.string().max(500).optional() }), false) },
    responses: { 200: json(ControlSchema, "State after pausing.") },
  }),
  async (c) => {
    const { reason } = (await c.req.json().catch(() => ({}))) as { reason?: string };
    pausePublishing(reason ?? null);
    return c.json(controlState(), 200);
  },
);

controlRoutes.openapi(
  createRoute({
    method: "post",
    path: "/control/resume",
    tags,
    operationId: "resumePublishing",
    summary: "Resume publishing",
    description: "Only the person (owner). Posts whose time passed while paused go out now, or become due if they are later than lateGraceMinutes.",
    responses: { 200: json(ControlSchema, "State after resuming."), 403: E403 },
  }),
  (c) => {
    resumePublishing();
    return c.json(controlState(), 200);
  },
);

controlRoutes.openapi(
  createRoute({
    method: "get",
    path: "/audit",
    tags,
    operationId: "listAudit",
    summary: "Who did what",
    description: "Every change with its actor (agent:mcp, agent:operator, owner:ui, owner:telegram:@name, system:scheduler), newest first.",
    request: {
      query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), postId: z.string().optional() }),
    },
    responses: { 200: json(z.object({ entries: z.array(AuditSchema) }), "Entries.") },
  }),
  (c) => c.json({ entries: listAudit(c.req.valid("query")) }, 200),
);

const FeedbackSchema = z
  .object({
    id: z.number().int(),
    at: z.iso.datetime(),
    decision: z.enum(["changes_requested", "rejected", "approved"]),
    note: z.string().nullable(),
    by: z.string(),
    postId: z.string().nullable(),
    post: z
      .object({ title: z.string().nullable(), preview: z.string(), source: z.string() })
      .nullable()
      .openapi({ description: "The post as it is now (it may have been revised since); null once deleted." }),
  })
  .openapi("Feedback");

controlRoutes.openapi(
  createRoute({
    method: "get",
    path: "/feedback",
    tags,
    operationId: "listFeedback",
    summary: "What the person said about past posts",
    description:
      "Every note the person left when deciding, newest first: sent back for changes, rejected (often without a note), or approved with a note. " +
      "Their standing preferences: agents should read them before drafting and apply them to everything they write.",
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
    responses: { 200: json(z.object({ feedback: z.array(FeedbackSchema) }), "Feedback.") },
  }),
  (c) => c.json({ feedback: listFeedback(c.req.valid("query").limit ?? 30) }, 200),
);

controlRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/feedback/{id}",
    tags,
    operationId: "forgetFeedback",
    summary: "Make agents forget a note",
    description: "It no longer appears in GET /api/feedback or get_feedback. The audit log keeps the decision. Only the person (owner).",
    request: { params: z.object({ id: z.coerce.number().int() }) },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Forgotten."), 403: E403, 404: json(Err, "No such feedback, or already forgotten.") },
  }),
  (c) => {
    requireOwner("make agents forget feedback");
    if (!forgetFeedback(c.req.valid("param").id)) throw new NotFoundError("No such feedback, or it was already forgotten.");
    return c.json({ ok: true as const }, 200);
  },
);

controlRoutes.openapi(
  createRoute({
    method: "post",
    path: "/feedback/{id}/restore",
    tags,
    operationId: "restoreFeedback",
    summary: "Undo forgetting a note",
    description: "Agents see the note again (GET /api/feedback, get_feedback). Only the person (owner).",
    request: { params: z.object({ id: z.coerce.number().int() }) },
    responses: { 200: json(z.object({ ok: z.literal(true) }), "Restored."), 403: E403, 404: json(Err, "No forgotten feedback with this id.") },
  }),
  (c) => {
    requireOwner("restore feedback");
    if (!restoreFeedback(c.req.valid("param").id)) throw new NotFoundError("No forgotten feedback with this id.");
    return c.json({ ok: true as const }, 200);
  },
);

controlRoutes.openapi(
  createRoute({
    method: "get",
    path: "/digest",
    tags,
    operationId: "getDigest",
    summary: "The daily digest, now",
    description: "The text the approval chats get each day at digest.time: waiting decisions, what goes out next, results, problems.",
    responses: { 200: json(z.object({ text: z.string() }), "Digest text.") },
  }),
  async (c) => c.json({ text: await digestText() }, 200),
);

controlRoutes.openapi(
  createRoute({
    method: "post",
    path: "/channels/test",
    tags,
    operationId: "testChannels",
    summary: "Send a test message to the approval chats",
    description: "Checks the configured approval chats (settings on the Plugins page, or TELEGRAM_APPROVAL_* / DISCORD_APPROVAL_* in .env) by sending a hello (and the digest if `digest` is true).",
    request: { body: body(z.object({ digest: z.boolean().optional() }), false) },
    responses: { 200: json(z.object({ channels: z.array(ChannelSchema) }), "Channel states after sending."), 403: E403 },
  }),
  async (c) => {
    requireOwner("test the approval chats");
    const { digest } = (await c.req.json().catch(() => ({}))) as { digest?: boolean };
    const channels = await testChannels();
    if (digest) await sendDigest();
    return c.json({ channels }, 200);
  },
);
