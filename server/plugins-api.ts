// REST for plugins, mounted at /api: list, switch on and off, settings. Changing plugins is for the person only: a
// plugin runs with the server's full access. Adding one is a file-system step (<DATA_DIR>/plugins/ or plugins.load).
import { createRoute, z } from "@hono/zod-openapi";
import { requireOwner } from "./actor.ts";
import { audit } from "./audit.ts";
import { createRouter } from "./http.ts";
import { PLUGIN_API_VERSION } from "./plugin-api.ts";
import { listPlugins, missingSettings, saveSettings, setPluginEnabled, settingsView, type PluginRecord } from "./plugins.ts";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const Err = z.object({ error: z.string(), message: z.string() });
const E400 = json(Err, "A value doesn't fit its setting.");
const E403 = json(Err, "Only the person (owner) can change plugins; agents get 403.");
const E409 = json(Err, "The plugin is switched off in yaypost.config.json.");
const tags = ["Plugins"];

const PluginSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().nullable(),
    source: z.enum(["built-in", "data", "config"]).openapi({
      description: "built-in: plugins/ · data: <DATA_DIR>/plugins/ · config: yaypost.config.json plugins.load.",
    }),
    platforms: z.array(z.string()),
    channels: z.array(z.string()),
    error: z.string().nullable().openapi({ description: "Why it isn't loaded; null when it is." }),
    disabled: z.boolean(),
    disabledByConfig: z.boolean().openapi({ description: "Switched off in yaypost.config.json; only the config file turns it back on." }),
    hasSettings: z.boolean().openapi({ description: "It declares settings (GET /plugins/settings)." }),
    settingsMissing: z.array(z.string()).openapi({ description: "Required settings with no value yet." }),
  })
  .openapi("Plugin");

const SettingFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["string", "text", "number", "boolean"]).optional(),
    secret: z.boolean().optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    placeholder: z.string().optional(),
    help: z.string().optional(),
    env: z.string().optional().openapi({ description: "Environment variable used when nothing is saved." }),
  })
  .openapi("PluginSettingField");

const SettingsSchema = z
  .object({
    name: z.string(),
    fields: z.array(SettingFieldSchema),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).openapi({ description: "Current non-secret values. Secrets are never returned." }),
    sources: z.record(z.string(), z.enum(["saved", "config", "env", "default", "unset"])).openapi({
      description: "Where each value comes from: saved here, yaypost.config.json, an environment variable, the default, or unset.",
    }),
    missing: z.array(z.string()),
  })
  .openapi("PluginSettings");

const PluginsSchema = z
  .object({
    plugins: z.array(PluginSchema),
    apiVersion: z.number().int().openapi({ description: "The plugin API version this server provides." }),
  })
  .openapi("Plugins");

const view = (p: PluginRecord) => {
  const { dir: _dir, settingsFields, ...rest } = p;
  return { ...rest, hasSettings: settingsFields.length > 0, settingsMissing: missingSettings(p) };
};

const state = () => ({ plugins: listPlugins().map(view), apiVersion: PLUGIN_API_VERSION });

const NameBody = z.object({ name: z.string().min(1).openapi({ description: "The plugin's package name (GET /plugins)." }) });

export const pluginRoutes = createRouter();

pluginRoutes.openapi(
  createRoute({
    method: "get",
    path: "/plugins",
    tags,
    operationId: "listPlugins",
    summary: "Plugins: what is loaded, from where, and what failed",
    description:
      "Every platform and approval chat is a plugin: built-in ones in plugins/, more from <DATA_DIR>/plugins/ or yaypost.config.json plugins.load, " +
      "loaded at startup. Each entry says what it provides, or why it didn't load.",
    responses: { 200: json(PluginsSchema, "Plugins in load order.") },
  }),
  (c) => c.json(state(), 200),
);

for (const [path, summary, description] of [
  ["enable", "Switch a plugin on", "Loads it now (its platforms and chats appear at once) and remembers the choice. Owner only."],
  ["disable", "Switch a plugin off", "Unregisters its platforms and chats now (posts to them fail until it is on again) and remembers the choice. Owner only."],
] as const) {
  pluginRoutes.openapi(
    createRoute({
      method: "post",
      path: `/plugins/${path}`,
      tags,
      operationId: `${path}Plugin`,
      summary,
      description,
      request: { body: body(NameBody) },
      responses: { 200: json(PluginsSchema, "Plugins after the change."), 403: E403, 404: json(Err, "No such plugin."), 409: E409 },
    }),
    async (c) => {
      requireOwner(`${path} plugins`);
      const { name } = c.req.valid("json");
      await setPluginEnabled(name, path === "enable");
      audit(`plugin.${path}d`, null, name);
      return c.json(state(), 200);
    },
  );
}

pluginRoutes.openapi(
  createRoute({
    method: "get",
    path: "/plugins/settings",
    tags,
    operationId: "getPluginSettings",
    summary: "A plugin's settings form and current values",
    description: "Fields as the plugin declares them, non-secret values, and where each value comes from. Secrets are never returned. Owner only.",
    request: { query: z.object({ name: z.string().min(1) }) },
    responses: { 200: json(SettingsSchema, "The form."), 403: E403, 404: json(Err, "No such plugin.") },
  }),
  (c) => {
    requireOwner("see plugin settings");
    const { name } = c.req.valid("query");
    return c.json({ name, ...settingsView(name) }, 200);
  },
);

pluginRoutes.openapi(
  createRoute({
    method: "post",
    path: "/plugins/settings",
    tags,
    operationId: "savePluginSettings",
    summary: "Save a plugin's settings",
    description:
      "`values`: key → new value; null clears a saved value (it falls back to the config file, the env variable or the default); a secret left out keeps " +
      "its stored value. Secrets are stored encrypted. The plugin reloads at once (its chats restart). Owner only.",
    request: {
      body: body(z.object({ name: z.string().min(1), values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) })),
    },
    responses: { 200: json(SettingsSchema.extend({ plugin: PluginSchema }), "Saved; the plugin's state after reloading."), 400: E400, 403: E403, 404: json(Err, "No such plugin.") },
  }),
  async (c) => {
    requireOwner("change plugin settings");
    const { name, values } = c.req.valid("json");
    const saved = await saveSettings(name, values);
    audit("plugin.settings_changed", null, `${name}: ${Object.keys(values).join(", ")}`);
    const plugin = view(listPlugins().find((p) => p.name === name)!);
    return c.json({ name, ...saved, plugin }, 200);
  },
);
