// Plugin loader and registry. Platforms and approval channels exist only as plugins: the built-in ones in plugins/,
// extra ones from <DATA_DIR>/plugins/, yaypost.config.json → plugins.load, and packages the person installed from
// the UI (server/plugin-install.ts, into <DATA_DIR>/plugin-packages). Each plugin directory has a package.json with a
// "yaypost" key ({ apiVersion, entry? }) and an entry module whose default export receives the YaypostAPI (see
// server/plugin-api.ts). A plugin that fails to load is skipped and reported (GET /api/plugins); it never takes the
// server down. Plugins can be switched on and off while running: deactivating removes what they registered and
// their event listeners; activating runs their factory again (factories have no side effects by contract).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Account } from "../shared/types.ts";
import { getConfig } from "./config.ts";
import { db, kv } from "./db.ts";
import { env, publicUrl, ROOT } from "./env.ts";
import { installedPackageDirs } from "./plugin-packages.ts";
import { bus } from "./events.ts";
import { signedMediaUrl } from "./media.ts";
import {
  PLUGIN_API_VERSION,
  type ChannelDefinition,
  type PlatformDefinition,
  type PlatformInfo,
  type PluginFactory,
  type SettingField,
  type YaypostAPI,
} from "./plugin-api.ts";
import { BadInputError, ConflictError, getMedia, NotFoundError, readMediaBytes } from "./repo.ts";
import { open, seal } from "./secrets.ts";

/** Thrown by platforms (ts.PlatformError): a message the person can act on, and whether Retry may resume. */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly resumable = true,
  ) {
    super(message);
  }
}

export interface PluginRecord {
  name: string;
  version: string;
  description: string | null;
  /** built-in: plugins/ · data: <DATA_DIR>/plugins/ · config: plugins.load · installed: from the UI or API. */
  source: "built-in" | "data" | "config" | "installed";
  dir: string;
  platforms: string[];
  channels: string[];
  /** Why it isn't loaded (bad manifest, wrong apiVersion, its factory threw…); null when it is. */
  error: string | null;
  disabled: boolean;
  /** Switched off in yaypost.config.json → plugins.disable: only the config file turns it back on. */
  disabledByConfig: boolean;
  /** New code is on disk (an update) but the running server still has the old one: restart to use it. */
  restartRequired: boolean;
  /** The settings form, from package.json → "yaypost".settings. */
  settingsFields: SettingField[];
}

interface Entry {
  record: PluginRecord;
  factory: PluginFactory | null;
  /** Event listeners the plugin added through ts.on(), removed when it is switched off. */
  unsubscribe: (() => void)[];
}

const entries: Entry[] = [];
const platforms = new Map<string, PlatformDefinition>();
const channels = new Map<string, ChannelDefinition>();
const channelListeners = new Set<(change: { added: ChannelDefinition[]; removed: ChannelDefinition[] }) => void>();

const ID = /^[a-z][a-z0-9-]{0,31}$/;

const Manifest = z.object({
  name: z.string().min(1),
  version: z.string().default("0.0.0"),
  description: z.string().optional(),
  yaypost: z.object({
    apiVersion: z.number().int(),
    entry: z.string().optional(),
    settings: z
      .array(
        z.object({
          key: z.string().regex(/^[A-Za-z][\w-]{0,63}$/),
          label: z.string().min(1),
          type: z.enum(["string", "text", "number", "boolean"]).optional(),
          secret: z.boolean().optional(),
          required: z.boolean().optional(),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
          placeholder: z.string().optional(),
          help: z.string().optional(),
          env: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

/** Read and check a plugin's package.json (used before installing, too). */
export function readManifest(dir: string): z.infer<typeof Manifest> {
  try {
    return Manifest.parse(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")));
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`not a Yaypost plugin: its package.json needs "yaypost": { "apiVersion": ${PLUGIN_API_VERSION} } (${z.prettifyError(err)})`);
    }
    throw err;
  }
}

// ---------- registry (what the rest of the server uses) ----------

/** A loaded platform, or a clear error naming what's missing (e.g. an account whose plugin was removed). */
export function platform(id: string): PlatformDefinition {
  const p = platforms.get(id);
  if (!p) throw new NotFoundError(`No plugin provides the platform "${id}". Loaded: ${[...platforms.keys()].join(", ") || "none"}.`);
  return p;
}

export const hasPlatform = (id: string) => platforms.has(id);
export const listPlatforms = (): PlatformDefinition[] => [...platforms.values()];
export const listChannels = (): ChannelDefinition[] => [...channels.values()];
export const listPlugins = (): PluginRecord[] => entries.map((e) => ({ ...e.record }));

/** A platform's display name, falling back to its id when its plugin isn't loaded (history stays readable). */
export const platformName = (id: string) => platforms.get(id)?.name ?? id;

/** How a platform threads; "replies" when its plugin isn't loaded (it can't publish then anyway). */
export const threadModeOf = (id: string) => platforms.get(id)?.threadMode ?? "replies";

/** The serializable part of a platform: what GET /api/platforms returns. */
export function platformInfo(p: PlatformDefinition): PlatformInfo & { hasMetrics: boolean } {
  return {
    id: p.id,
    name: p.name,
    maxChars: p.maxChars,
    ...(p.maxCharsWithMedia ? { maxCharsWithMedia: p.maxCharsWithMedia } : {}),
    maxImages: p.maxImages,
    ...(p.imageTypes ? { imageTypes: p.imageTypes } : {}),
    ...(p.maxImageBytes ? { maxImageBytes: p.maxImageBytes } : {}),
    threadMode: p.threadMode,
    counting: p.counting,
    costNote: p.costNote,
    setup: p.setup,
    credentials: p.credentials,
    ...(p.metricsNote ? { metricsNote: p.metricsNote } : {}),
    ...(p.metricsPaid ? { metricsPaid: true } : {}),
    ...(p.brand ? { brand: p.brand } : {}),
    hasMetrics: typeof p.metrics === "function",
  };
}

/** The text items a thread becomes on a platform (threadMode "single" joins them into one). */
export function itemsFor(p: Pick<PlatformInfo, "threadMode">, thread: { text: string; mediaIds: string[] }[]) {
  if (p.threadMode !== "single" || thread.length <= 1) return thread;
  return [{ text: thread.map((s) => s.text.trim()).filter(Boolean).join("\n\n"), mediaIds: thread.flatMap((s) => s.mediaIds) }];
}

// ---------- loading ----------

function apiFor(entry: Entry): YaypostAPI {
  const { record } = entry;
  const prefix = `[${record.name}]`;
  const storeKey = (key: string) => `plugin:${record.name}:${key}`;
  return {
    apiVersion: PLUGIN_API_VERSION,
    plugin: { name: record.name, version: record.version, dir: record.dir },
    registerPlatform(def) {
      if (!ID.test(def.id)) throw new Error(`platform id "${def.id}" must be lowercase letters, digits or dashes`);
      if (platforms.has(def.id)) throw new Error(`platform "${def.id}" is already provided by another plugin`);
      for (const fn of ["verify", "publish"] as const) if (typeof def[fn] !== "function") throw new Error(`platform "${def.id}" has no ${fn}()`);
      platforms.set(def.id, def);
      record.platforms.push(def.id);
    },
    registerChannel(def) {
      if (!ID.test(def.id)) throw new Error(`channel id "${def.id}" must be lowercase letters, digits or dashes`);
      if (channels.has(def.id)) throw new Error(`channel "${def.id}" is already provided by another plugin`);
      channels.set(def.id, def);
      record.channels.push(def.id);
    },
    on: (listener) => {
      const off = bus.on(listener);
      entry.unsubscribe.push(off);
      return off;
    },
    env: (name) => process.env[name]?.trim() || undefined,
    settings: () => resolveSettings(record).values,
    host: () => ({ timezone: getConfig().timezone, publicUrl: publicUrl(), publicUrlIsSet: Boolean(env.publicUrl) }),
    store: { get: (key) => kv.get(storeKey(key)), set: (key, value) => kv.set(storeKey(key), value) },
    media: {
      get: (id) => {
        const m = getMedia(id);
        return m ? { id: m.id, filename: m.filename, mime: m.mime, size: m.size, alt: m.alt } : undefined;
      },
      read: readMediaBytes,
      publicUrl: (id) => signedMediaUrl(id),
    },
    log: {
      info: (m) => console.log(prefix, m),
      warn: (m) => console.warn(prefix, m),
      error: (m) => console.error(prefix, m),
    },
    PlatformError,
  };
}

/** Plugin directories one level below `dir` (each with a package.json), sorted for a stable load order. */
function pluginDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .map((n) => path.join(dir, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(path.join(d, "package.json")))
    .sort();
}

/** A config entry: a path (relative to the config file) or an installed package name. */
function resolveEntry(spec: string): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) return path.resolve(path.dirname(env.configPath), spec);
  const pkg = createRequire(path.join(ROOT, "package.json")).resolve(`${spec}/package.json`);
  return path.dirname(pkg);
}

const UI_DISABLED = "plugins.disabled";
const uiDisabled = () => new Set(kv.get<string[]>(UI_DISABLED) ?? []);
const configDisabled = () => new Set(getConfig().plugins.disable);

function notifyChannels(added: ChannelDefinition[], removed: ChannelDefinition[]) {
  if (added.length || removed.length) for (const fn of channelListeners) fn({ added, removed });
}

/** Run a plugin's factory: it registers its platforms/channels, all or nothing. */
async function activate(entry: Entry): Promise<void> {
  const { record } = entry;
  record.error = null;
  record.platforms = [];
  record.channels = [];
  try {
    if (!entry.factory) {
      const manifest = readManifest(record.dir);
      if (manifest.yaypost.apiVersion !== PLUGIN_API_VERSION) {
        throw new Error(`written for plugin API ${manifest.yaypost.apiVersion}; this Yaypost provides ${PLUGIN_API_VERSION}`);
      }
      const file = path.resolve(record.dir, manifest.yaypost.entry ?? (existsSync(path.join(record.dir, "index.ts")) ? "index.ts" : "index.js"));
      const mod = (await import(pathToFileURL(file).href)) as { default?: PluginFactory };
      if (typeof mod.default !== "function") throw new Error(`${path.relative(record.dir, file)} has no default export function`);
      entry.factory = mod.default;
    }
    try {
      await entry.factory(apiFor(entry));
    } catch (err) {
      deactivate(entry, false);
      throw err;
    }
    // A platform or channel can be switched off on its own by id (config only).
    const off = configDisabled();
    for (const id of record.platforms) if (off.has(id)) platforms.delete(id);
    for (const id of record.channels) if (off.has(id)) channels.delete(id);
    notifyChannels(record.channels.flatMap((id) => channels.get(id) ?? []), []);
  } catch (err) {
    record.error = (err as Error).message;
    console.warn(`⚠ plugin ${record.name} not loaded: ${record.error}`);
  }
}

/** Undo activate(): unregister everything the plugin provided and drop its event listeners. */
function deactivate(entry: Entry, notify = true): void {
  const removed = entry.record.channels.flatMap((id) => channels.get(id) ?? []);
  for (const id of entry.record.platforms) platforms.delete(id);
  for (const id of entry.record.channels) channels.delete(id);
  for (const off of entry.unsubscribe.splice(0)) off();
  entry.record.platforms = [];
  entry.record.channels = [];
  if (notify) notifyChannels([], removed);
}

async function add(dir: string, source: PluginRecord["source"]): Promise<Entry> {
  const record: PluginRecord = {
    name: path.basename(dir),
    version: "0.0.0",
    description: null,
    source,
    dir,
    platforms: [],
    channels: [],
    error: null,
    disabled: false,
    disabledByConfig: false,
    restartRequired: false,
    settingsFields: [],
  };
  const entry: Entry = { record, factory: null, unsubscribe: [] };
  entries.push(entry);
  try {
    const manifest = readManifest(dir);
    Object.assign(record, { name: manifest.name, version: manifest.version, description: manifest.description ?? null, settingsFields: manifest.yaypost.settings });
    if (entries.some((e) => e !== entry && e.record.name === record.name)) throw new Error(`a plugin named ${record.name} is already loaded`);
  } catch (err) {
    record.error = (err as Error).message;
    console.warn(`⚠ plugin ${record.name} not loaded: ${record.error}`);
    return entry;
  }
  record.disabledByConfig = configDisabled().has(record.name);
  record.disabled = record.disabledByConfig || uiDisabled().has(record.name);
  if (!record.disabled) await activate(entry);
  return entry;
}

const find = (name: string) => {
  const e = entries.find((x) => x.record.name === name);
  if (!e) throw new NotFoundError(`No plugin named ${name}`);
  return e;
};

/** Switch a plugin on or off while running (remembered across restarts). */
export async function setPluginEnabled(name: string, enabled: boolean): Promise<PluginRecord> {
  const entry = find(name);
  const { record } = entry;
  if (record.disabledByConfig && enabled) {
    throw new ConflictError(`${name} is disabled in yaypost.config.json (plugins.disable); remove it there to turn it on.`);
  }
  const off = uiDisabled();
  if (enabled) off.delete(name);
  else off.add(name);
  kv.set(UI_DISABLED, [...off]);
  if (enabled && record.disabled) {
    record.disabled = false;
    await activate(entry);
  } else if (!enabled && !record.disabled) {
    deactivate(entry);
    record.disabled = true;
    record.error = null;
  }
  return { ...record };
}

/** Load a plugin the person just installed (or note that a restart is needed to run its new code). */
export async function addInstalled(dir: string): Promise<PluginRecord> {
  const name = readManifest(dir).name;
  const existing = entries.find((e) => e.record.name === name);
  if (existing) {
    if (existing.record.source !== "installed") throw new ConflictError(`A ${existing.record.source} plugin named ${name} already exists.`);
    // Same plugin, new version: the running process keeps the old module until it restarts.
    const manifest = readManifest(dir);
    const changed = manifest.version !== existing.record.version;
    existing.record.version = manifest.version;
    existing.record.settingsFields = manifest.yaypost.settings;
    existing.record.restartRequired ||= changed && Boolean(existing.factory);
    return { ...existing.record };
  }
  return { ...(await add(dir, "installed")).record };
}

/** Forget an installed plugin (after its package was removed). */
export function removeInstalled(name: string): void {
  const entry = find(name);
  if (entry.record.source !== "installed") throw new ConflictError(`${name} is ${entry.record.source}; only plugins installed from the UI can be uninstalled here.`);
  deactivate(entry);
  entries.splice(entries.indexOf(entry), 1);
  kv.set(settingsKey(name), null);
  const off = uiDisabled();
  if (off.delete(name)) kv.set(UI_DISABLED, [...off]);
}

/** Approval chats added or removed at runtime (the notification hub starts and stops them). */
export function onChannelsChange(fn: (change: { added: ChannelDefinition[]; removed: ChannelDefinition[] }) => void): () => void {
  channelListeners.add(fn);
  return () => channelListeners.delete(fn);
}

let loaded = false;

/** Load every plugin once, at startup, before the server takes requests. */
export async function loadPlugins(): Promise<void> {
  if (loaded) return;
  loaded = true;
  for (const dir of pluginDirs(path.join(ROOT, "plugins"))) await add(dir, "built-in");
  for (const dir of pluginDirs(path.join(env.dataDir, "plugins"))) await add(dir, "data");
  for (const spec of getConfig().plugins.load) {
    let dir: string;
    try {
      dir = resolveEntry(spec);
    } catch (err) {
      entries.push({
        record: {
          name: spec,
          version: "",
          description: null,
          source: "config",
          dir: "",
          platforms: [],
          channels: [],
          error: `can't find it: ${(err as Error).message}`,
          disabled: false,
          disabledByConfig: false,
          restartRequired: false,
          settingsFields: [],
        },
        factory: null,
        unsubscribe: [],
      });
      console.warn(`⚠ plugin ${spec} not found`);
      continue;
    }
    await add(dir, "config");
  }
  for (const dir of installedPackageDirs()) await add(dir, "installed");
  // Accounts whose platform no plugin provides can't publish; say so where the person looks.
  for (const row of db.prepare("SELECT id, platform FROM accounts WHERE removed_at IS NULL").all() as Pick<Account, "id" | "platform">[]) {
    if (!platforms.has(row.platform)) {
      db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(`No loaded plugin provides "${row.platform}"; posts to this account will fail until it is installed or enabled.`, row.id);
    }
  }
}

// ---------- settings ----------

interface StoredSettings {
  values: Record<string, string | number | boolean>;
  /** Secrets, each sealed (AES-256-GCM, see server/secrets.ts). */
  secrets: Record<string, string>;
}

export type SettingSource = "saved" | "config" | "env" | "default" | "unset";

const settingsKey = (name: string) => `plugin-settings:${name}`;
const stored = (name: string): StoredSettings => kv.get<StoredSettings>(settingsKey(name)) ?? { values: {}, secrets: {} };

function coerce(field: SettingField, raw: unknown): string | number | boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (field.type === "number") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? n : undefined;
  }
  if (field.type === "boolean") return typeof raw === "boolean" ? raw : /^(1|true|yes|on)$/i.test(String(raw).trim());
  return typeof raw === "string" ? raw : String(raw);
}

/** Effective values and where each came from: saved on the Plugins page > config file > env variable > default. */
function resolveSettings(record: PluginRecord): { values: Record<string, unknown>; sources: Record<string, SettingSource> } {
  const saved = stored(record.name);
  const config = (getConfig().plugins.settings[record.name] as Record<string, unknown> | undefined) ?? {};
  const values: Record<string, unknown> = { ...config };
  const sources: Record<string, SettingSource> = {};
  for (const f of record.settingsFields) {
    const candidates: [SettingSource, unknown][] = [
      ["saved", f.secret ? (saved.secrets[f.key] ? open(saved.secrets[f.key]!) : undefined) : saved.values[f.key]],
      ["config", config[f.key]],
      ["env", f.env ? process.env[f.env]?.trim() : undefined],
      ["default", f.default],
    ];
    const hit = candidates.map(([src, raw]) => [src, coerce(f, raw)] as const).find(([, v]) => v !== undefined);
    values[f.key] = hit?.[1];
    sources[f.key] = hit?.[0] ?? "unset";
  }
  return { values, sources };
}

export interface SettingsView {
  fields: SettingField[];
  /** Non-secret values; secrets are never returned (see `sources` for whether one is set). */
  values: Record<string, string | number | boolean | null>;
  sources: Record<string, SettingSource>;
  /** Required fields that have no value anywhere. */
  missing: string[];
}

export function settingsView(name: string): SettingsView {
  const { record } = find(name);
  const { values, sources } = resolveSettings(record);
  return {
    fields: record.settingsFields,
    values: Object.fromEntries(record.settingsFields.filter((f) => !f.secret).map((f) => [f.key, (values[f.key] as string | number | boolean | undefined) ?? null])),
    sources,
    missing: record.settingsFields.filter((f) => f.required && sources[f.key] === "unset").map((f) => f.key),
  };
}

/** Required settings a plugin still lacks (for the plugin list). */
export const missingSettings = (record: PluginRecord) =>
  record.settingsFields.length ? record.settingsFields.filter((f) => f.required && resolveSettings(record).sources[f.key] === "unset").map((f) => f.key) : [];

/**
 * Save settings from the Plugins page. A key set to null is cleared (it falls back to config, env or default); a secret
 * left out keeps its stored value. The plugin is reloaded so it picks the values up (its chats restart).
 */
export async function saveSettings(name: string, patch: Record<string, unknown>): Promise<SettingsView> {
  const entry = find(name);
  const fields = new Map(entry.record.settingsFields.map((f) => [f.key, f]));
  const next = stored(name);
  for (const [key, raw] of Object.entries(patch)) {
    const field = fields.get(key);
    if (!field) throw new BadInputError(`${name} has no setting "${key}".`);
    if (raw === null) {
      delete next.values[key];
      delete next.secrets[key];
      continue;
    }
    const value = coerce(field, raw);
    if (value === undefined) {
      if (raw === "") continue;
      throw new BadInputError(`${field.label}: expected ${field.type ?? "text"}.`);
    }
    if (field.secret) next.secrets[key] = seal(String(value));
    else next.values[key] = value;
  }
  kv.set(settingsKey(name), next);
  if (!entry.record.disabled && entry.factory) {
    deactivate(entry);
    await activate(entry);
  }
  return settingsView(name);
}
