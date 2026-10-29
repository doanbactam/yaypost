// Domain types shared by server, web UI, CLI and MCP tools.

export const POST_STATUSES = ["draft", "scheduled", "publishing", "due", "published", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];
// draft      – not in the queue
// scheduled  – waiting for its time
// publishing – claimed by the scheduler, platform API calls in flight
// due        – missed its time while the server was off: the user decides (publish now, copy & post by hand, reschedule)
// published  – live on every destination (or marked by hand)
// failed     – a destination failed; `error` and each target's `error` say why, `externalIds` what did go out

export type PostSource = "ui" | "api" | "mcp" | "cli" | "ai" | "operator";

export const APPROVAL_STATES = ["pending", "approved", "changes_requested", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
// pending           – an agent wants it out; nothing is published until the person decides
// approved          – the person approved this content (an agent's later content edit asks again)
// changes_requested – the person sent feedback (`note`); the agent revises, which asks again
// rejected          – the person said no; the post went back to drafts

/** The person's decision on agent-made content. null: no decision needed (made by the person, or never queued). */
export interface Approval {
  state: ApprovalState;
  /** Feedback from the person (changes requested or rejection reason). */
  note: string | null;
  /** Who asked (while pending) or decided, as actor:surface, e.g. "agent:mcp", "owner:ui", "owner:telegram:@alice". */
  by: string | null;
  at: string | null;
}

export interface Segment {
  id: string;
  text: string;
  mediaIds: string[];
}

/** A platform's id, as its plugin registers it ("x", "bluesky", …). GET /api/platforms lists the loaded ones. */
export type PlatformId = string;

/** A connected social account. Credentials never leave the server; `handle` is what the platform calls the account. */
export interface Account {
  id: string;
  platform: PlatformId;
  label: string;
  handle: string | null;
  profileUrl: string | null;
  /** Per-account character limit override (e.g. X Premium 25000, a Mastodon instance's own limit). */
  maxChars: number | null;
  lastError: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export type TargetStatus = "pending" | "published" | "failed";

/** Public engagement of one posted item, as the platform reports it (absent = the platform doesn't expose it). */
export interface ItemMetrics {
  id: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  bookmarks?: number;
}

export interface TargetMetrics {
  fetchedAt: string;
  items: ItemMetrics[];
  /** Sums over items for each metric the platform reports. */
  totals: Omit<ItemMetrics, "id">;
}

/** One destination of a post. With `thread` null it publishes the post's own thread; otherwise its own version. */
export interface PostTarget {
  accountId: string;
  platform: PlatformId;
  thread: Segment[] | null;
  /** true when `thread` is the shared thread as it was when this destination published (history, not a version). */
  snapshot: boolean;
  status: TargetStatus;
  externalIds: string[]; // items already posted on that platform, in order (resume after a partial failure)
  url: string | null;
  error: string | null;
  publishedAt: string | null;
  /** Last engagement snapshot (GET /api/posts/{id}/metrics?refresh=true updates it); null until fetched. */
  metrics: TargetMetrics | null;
}

export interface Post {
  id: string;
  title: string | null;
  status: PostStatus;
  thread: Segment[];
  scheduledAt: string | null; // ISO-8601 UTC
  publishedAt: string | null;
  error: string | null;
  url: string | null; // link to the first destination's post once published
  /**
   * Accounts this post goes to (at least one to schedule or publish). Each one publishes and resumes independently;
   * the post's status summarises them.
   */
  targets: PostTarget[];
  /** Human approval of agent-made content (see ApprovalState). Scheduled posts only go out when null or approved. */
  approval: Approval | null;
  source: PostSource;
  createdAt: string;
  updatedAt: string;
}

export interface Media {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string | null;
  url: string; // served at /media/:id
  createdAt: string;
}

export interface QueueSlotItem {
  type: "slot";
  at: string; // ISO UTC, a free slot from the config
}
export interface QueuePostItem {
  type: "post";
  at: string;
  post: Post;
}
export type QueueItem = QueueSlotItem | QueuePostItem;

export interface QueueDay {
  date: string; // YYYY-MM-DD in the configured timezone
  items: QueueItem[];
}

export interface Queue {
  timezone: string;
  days: QueueDay[];
}

export type AppEvent =
  | {
      type:
        | "post.created"
        | "post.updated"
        | "post.scheduled"
        | "post.due"
        | "post.published"
        | "post.failed"
        | "post.approval_requested"
        | "post.approved"
        | "post.changes_requested"
        | "post.rejected";
      post: Post;
    }
  | { type: "post.deleted"; id: string }
  | { type: "publishing.paused" | "publishing.resumed"; by: string; reason: string | null };

export type AppEventType = AppEvent["type"];

export const APP_EVENT_TYPES: AppEventType[] = [
  "post.created",
  "post.updated",
  "post.scheduled",
  "post.due",
  "post.published",
  "post.failed",
  "post.deleted",
  "post.approval_requested",
  "post.approved",
  "post.changes_requested",
  "post.rejected",
  "publishing.paused",
  "publishing.resumed",
];

/** Events in words, grouped the way a person thinks about them (webhook pickers, delivery logs, chat messages). */
export const EVENT_GROUPS: { label: string; events: { type: AppEventType; label: string }[] }[] = [
  {
    label: "Publishing",
    events: [
      { type: "post.published", label: "Published" },
      { type: "post.failed", label: "Failed" },
      { type: "post.due", label: "Due, needs you" },
      { type: "publishing.paused", label: "Publishing paused" },
      { type: "publishing.resumed", label: "Publishing resumed" },
    ],
  },
  {
    label: "Approvals",
    events: [
      { type: "post.approval_requested", label: "Approval requested" },
      { type: "post.approved", label: "Approved" },
      { type: "post.changes_requested", label: "Changes requested" },
      { type: "post.rejected", label: "Rejected" },
    ],
  },
  {
    label: "Posts",
    events: [
      { type: "post.created", label: "Created" },
      { type: "post.updated", label: "Edited" },
      { type: "post.scheduled", label: "Scheduled" },
      { type: "post.deleted", label: "Deleted" },
    ],
  },
];
export const EVENT_LABEL = Object.fromEntries(EVENT_GROUPS.flatMap((g) => g.events.map((e) => [e.type, e.label]))) as Record<AppEventType, string>;

/** Kill switch: while set, nothing is published (scheduler and "publish now"). */
export interface PauseState {
  at: string;
  by: string;
  reason: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  /** "agent:mcp", "agent:operator", "owner:ui", "owner:telegram:@alice", "system:scheduler", … */
  actor: string;
  action: string;
  postId: string | null;
  detail: string | null;
}

/** A note the person left when deciding on a post (GET /api/feedback): what agents should learn from. */
export interface Feedback {
  /** The audit entry it comes from; DELETE /api/feedback/{id} makes agents forget it. */
  id: number;
  at: string;
  decision: "changes_requested" | "rejected" | "approved";
  note: string | null;
  by: string;
  postId: string | null;
  /** The post as it is now (it may have been revised since); null once deleted. */
  post: { title: string | null; preview: string; source: string } | null;
}

export interface ChannelStatus {
  /** The approval channel's id, as its plugin registers it ("telegram", "discord", …). */
  id: string;
  name: string;
  configured: boolean;
  connected: boolean;
  error: string | null;
}

export interface OperatorRun {
  id: string;
  trigger: string;
  task: string | null;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
  toolCalls: number;
  /** "anthropic" or "zai"; null for runs from before this was recorded. */
  provider: string | null;
  model: string | null;
}

export interface OperatorStatus {
  configured: boolean;
  enabled: boolean;
  reason: string | null;
  model: string | null;
  running: boolean;
  nextRunAt: string | null;
  lastRun: OperatorRun | null;
}

/** What the person sets up for the operator in the app: its schedule (yaypost.config.json) and its brief (operator.md). */
export interface OperatorSettings {
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  runAt: string[];
  /** The brief, or the example to start from when there is none yet (briefMissing). */
  brief: string;
  briefMissing: boolean;
  /** URLs of the remote MCP servers (web search…) the operator uses; headers and tool lists stay in yaypost.config.json. */
  sources: string[];
}

/** A remote MCP server checked from the operator settings: the tools the operator would get from it. */
export interface OperatorSourceCheck {
  url: string;
  name: string;
  tools: string[];
  error: string | null;
}

export interface ControlState {
  paused: PauseState | null;
  approval: { require: "agents" | "never"; except: PlatformId[] };
  /** What the caller is: the person (owner) or an agent. Only the owner can approve, resume, connect accounts. */
  role: "owner" | "agent";
  channels: ChannelStatus[];
  operator: OperatorStatus;
  pendingApprovals: number;
}

export interface Health {
  ok: true;
  version: string;
  timezone: string;
  ai: { configured: boolean; provider: string | null; model: string | null };
  paused: boolean;
  auth: { required: boolean };
}
