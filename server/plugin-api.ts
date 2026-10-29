// The plugin contract. Every platform (X, Bluesky, …) and every approval channel (Telegram, Discord) is a plugin with
// the same shape, built-in ones included, the way pi.dev builds its own features as extensions:
//
//   my-plugin/
//     package.json   { "name": "yaypost-plugin-foo", "version": "1.0.0", "keywords": ["yaypost-plugin"],
//                      "yaypost": { "apiVersion": 1, "entry": "index.ts" },
//                      "peerDependencies": { "yaypost": "*" } }
//     index.ts       export default function (ts: YaypostAPI) { ts.registerPlatform({ … }) }
//
// Plugins import only types from here (`import type … from "yaypost/plugin"`); everything they call at runtime
// comes through the `ts` object, so a plugin never reaches into Yaypost's internals and keeps working across
// releases with the same apiVersion. The factory may be async; it must not start timers, sockets or pollers (do that
// in a channel's start()). Plugins run with the server's full permissions: load only code you trust.
import type { CountingRule } from "../shared/counting.ts";
import type { Account, AppEvent, ChannelStatus, ItemMetrics } from "../shared/types.ts";

export type { CountingRule } from "../shared/counting.ts";
export type { Account, AppEvent, ChannelStatus, ItemMetrics } from "../shared/types.ts";

/** Bumped only on breaking changes; a plugin declaring another version is not loaded. */
export const PLUGIN_API_VERSION = 1;

// ---------- platforms ----------

/**
 * How a multi-post thread lands on the platform:
 * - "replies": each post replies to the previous one (X, Bluesky, Mastodon, Threads)
 * - "single": the posts are joined into one post, separated by blank lines (LinkedIn has no threads)
 * - "messages": consecutive messages in the channel (Telegram replies to the previous one, Discord just follows)
 */
export type ThreadMode = "replies" | "single" | "messages";

/** One credential the person enters when connecting an account; stored encrypted, never shown to agents. */
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

/** What a platform allows, as data. Served as-is by GET /api/platforms to the web UI, the CLI and agents. */
export interface PlatformInfo {
  /** Stable id stored with accounts: lowercase letters, digits and dashes. */
  id: string;
  name: string;
  /** Default per-post limit (an account can override it). */
  maxChars: number;
  /** Lower limit for an item that carries images (Telegram photo captions: 1024). */
  maxCharsWithMedia?: number;
  maxImages: number;
  /** Image types the platform accepts (all of PNG, JPEG, WebP, GIF when absent). */
  imageTypes?: string[];
  /** Largest image accepted, in bytes (Yaypost's own 5 MB limit applies otherwise). */
  maxImageBytes?: number;
  threadMode: ThreadMode;
  counting: CountingRule;
  /** Cost or access note shown wherever the account is connected. */
  costNote: string;
  /** Where to get the credentials, one line. */
  setup: string;
  credentials: CredentialField[];
  /** One line for agents/UI when engagement reads cost money or need an extra permission. */
  metricsNote?: string;
  /** Reading metrics is billed (X): Yaypost only calls metrics() when the caller passes paid=true. */
  metricsPaid?: boolean;
  /** Look in the UI: brand color (#rrggbb) and an optional 24×24 SVG path. */
  brand?: { color: string; iconPath?: string };
}

export interface PublishItem {
  text: string;
  mediaIds: string[];
}

export type Credentials = Record<string, string>;

export interface PublishContext {
  /** The Yaypost post being published (stable across retries; useful for idempotency keys). */
  postId: string;
  /** The connected account. */
  account: Account;
  credentials: Credentials;
  /** What to post, already shaped for the platform (threadMode "single": one joined item). */
  items: PublishItem[];
  /** Platform ids of items already posted by an earlier attempt, in order: skip them and continue after the last. */
  posted: string[];
  /** Call after every successful item with all ids so far; it is saved at once so a crash never re-posts. */
  record(ids: string[]): void;
}

export interface PublishResult {
  ids: string[];
  /** Public link to the first item. */
  url: string | null;
}

export interface MetricsContext {
  account: Account;
  credentials: Credentials;
  /** Ids of the posted items, as publish() returned them. */
  externalIds: string[];
}

export interface PlatformDefinition extends PlatformInfo {
  /** Check credentials with a cheap authenticated call; return who they belong to. Throw ts.PlatformError if not. */
  verify(credentials: Credentials): Promise<{ handle: string; profileUrl: string | null }>;
  /** Post `items` in order (threading per threadMode), resuming after `posted`. Throw ts.PlatformError on failure. */
  publish(ctx: PublishContext): Promise<PublishResult>;
  /** Public engagement of posted items, one entry per id. Omit when the platform has no read API. Read-only, cheap. */
  metrics?(ctx: MetricsContext): Promise<ItemMetrics[]>;
}

/**
 * An error with a message the person (or agent) can act on. `resumable`: Retry can continue after the items already
 * posted (false when, say, the post being replied to was deleted).
 */
export interface PlatformErrorConstructor {
  new (message: string, status?: number, resumable?: boolean): Error & { status?: number; resumable: boolean };
}

// ---------- approval channels ----------

export type ChannelAction = "approve" | "reject" | "changes" | "pause" | "resume";
export type ChannelCommand = "pending" | "status" | "pause" | "resume" | "run";

export interface ChannelButton {
  label: string;
  action: ChannelAction;
  postId?: string;
}

export interface ChannelMessage {
  /** Plain text (no markup), already cut to the channel's maxLength. */
  text: string;
  buttons?: ChannelButton[];
}

export interface ChannelHandlers {
  /**
   * A person pressed a button or answered a "what should change?" prompt. The channel has already checked they may
   * decide. `who` names them for the audit log, e.g. "telegram:@alice". Returns a short confirmation to show them.
   */
  act(who: string, action: ChannelAction, postId: string | null, note?: string): Promise<string>;
  /** A text command (/pending, /status, /pause [reason], /resume, /run [task]). Returns the reply text. */
  command(who: string, command: ChannelCommand, arg?: string): Promise<string>;
  /** The post an approval message (by the ref send() returned) is about, for replies to it. */
  postForRef(ref: string): string | null;
}

/** A chat where the person gets approval requests, alerts and the digest, and decides. */
export interface ChannelDefinition {
  /** Stable id (lowercase): stored with the messages it sent. */
  id: string;
  name: string;
  /** Longest text one message can carry. */
  maxLength: number;
  /** Whether it has what it needs to run (e.g. its env variables). Unconfigured channels are never started. */
  configured(): boolean;
  /** Live state for the UI: connected, last error. */
  status(): Omit<ChannelStatus, "id" | "name" | "configured">;
  /** Text commands this channel understands, for the hello message ("" when it has none). */
  commandsHint?: string;
  /** Start receiving (long polling, a gateway…). */
  start(handlers: ChannelHandlers): void;
  stop(): void;
  /** Send a message; resolves with a ref for finalize(), or null if it couldn't be sent (log, never throw). */
  send(message: ChannelMessage): Promise<string | null>;
  /** Replace a sent message's text (≤ maxLength) and remove its buttons. Never throws (log instead). */
  finalize(ref: string, text: string): Promise<void>;
}

// ---------- settings ----------

/**
 * One setting a plugin declares, as data, in its package.json: "yaypost": { "apiVersion": 1, "settings": [ … ] }.
 * The Plugins page renders a form from these without running the plugin; secrets are stored encrypted and never shown
 * again. Values reach the plugin through ts.settings().
 */
export interface SettingField {
  key: string;
  label: string;
  /** "string" (default), "text" (multi-line), "number" or "boolean". */
  type?: "string" | "text" | "number" | "boolean";
  /** Stored encrypted; the UI shows only whether it is set. */
  secret?: boolean;
  /** The plugin can't work without it; the UI flags the plugin until it is set. */
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  /** Environment variable used when nothing is saved, so .env setups keep working. */
  env?: string;
}

// ---------- the object every plugin gets ----------

export interface MediaFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string | null;
}

export interface YaypostAPI {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  /** This plugin, from its package.json. */
  readonly plugin: { name: string; version: string; dir: string };

  registerPlatform(definition: PlatformDefinition): void;
  registerChannel(definition: ChannelDefinition): void;
  /** Every state change (read-only). Returns an unsubscribe function. */
  on(listener: (event: AppEvent) => void): () => void;

  /** An environment variable (.env is already loaded), trimmed; undefined when empty. */
  env(name: string): string | undefined;
  /**
   * This plugin's settings, by key. For each field declared in package.json → "yaypost".settings: the value saved on
   * the Plugins page (secrets decrypted), else yaypost.config.json → plugins.settings["<plugin name>"], else the
   * field's `env` variable, else its `default`. Read it when you need a value (it changes when the person saves; the
   * plugin is also reloaded then). Undeclared keys from the config file are passed through as they are.
   */
  settings(): Record<string, unknown>;
  /** Server-wide settings plugins may need. */
  host(): { timezone: string; publicUrl: string; publicUrlIsSet: boolean };
  /** Small persistent key-value store, private to this plugin (cursors, caches). Values must be JSON. */
  store: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  media: {
    get(id: string): MediaFile | undefined;
    read(id: string): Buffer;
    /**
     * Signed URL of an image, valid for an hour, for platforms that fetch images by URL. It is only reachable from
     * the internet when PUBLIC_URL is set (host().publicUrlIsSet).
     */
    publicUrl(id: string): string;
  };
  log: { info(message: string): void; warn(message: string): void; error(message: string): void };
  PlatformError: PlatformErrorConstructor;
}

/** The default export of a plugin's entry module. */
export type PluginFactory = (ts: YaypostAPI) => void | Promise<void>;
