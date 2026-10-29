// REST for plugins, mounted at /api: list, browse the npm catalog, install (npm/git/.tgz), update, uninstall, switch
// on and off, restart. Changing plugins is for the person only: a plugin runs with the server's full access.
import { createRoute, z } from "@hono/zod-openapi";
import { actorLabel, requireOwner } from "./actor.ts";
import { audit } from "./audit.ts";
import { createRouter } from "./http.ts";
import { PLUGIN_API_VERSION } from "./plugin-api.ts";
import {
  installedSpec,
  installPackage,
  installTarball,
  npmAvailable,
  PLUGIN_KEYWORD,
  searchCatalog,
  uninstallPackage,
  updatePackage,
} from "./plugin-packages.ts";
import {
  addInstalled,
  listPlugins,
  missingSettings,
  readManifest,
  removeInstalled,
  saveSettings,
  setPluginEnabled,
  settingsView,
  type PluginRecord,
} from "./plugins.ts";

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const Err = z.object({ error: z.string(), message: z.string() });
const E400 = json(Err, "Not installable (bad spec, not a Yaypost plugin, wrong plugin API version).");
const E403 = json(Err, "Only the person (owner) can change plugins; agents get 403.");
const E409 = json(Err, "npm failed or isn't available, or the plugin isn't in a state for this.");
const tags = ["Plugins"];

const PluginSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string().nullable(),
    source: z.enum(["built-in", "data", "config", "installed"]).openapi({
      description: "built-in: plugins/ · data: <DATA_DIR>/plugins/ · config: yaypost.config.json plugins.load · installed: from the UI or this API.",
    }),
    platforms: z.array(z.string()),
    channels: z.array(z.string()),
    error: z.string().nullable().openapi({ description: "Why it isn't loaded; null when it is." }),
    disabled: z.boolean(),
    disabledByConfig: z.boolean().openapi({ description: "Switched off in yaypost.config.json; only the config file turns it back on." }),
    restartRequired: z.boolean().openapi({ description: "An update is installed; restart Yaypost to run the new code." }),
    spec: z.string().nullable().openapi({ description: "What it was installed from (installed plugins only)." }),
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
    canInstall: z.boolean().openapi({ description: "Whether npm is available to install plugins from here." }),
    restartRequired: z.boolean(),
  })
  .openapi("Plugins");

const CatalogSchema = z
  .object({
    keyword: z.string(),
    packages: z.array(
      z.object({
        name: z.string(),
        version: z.string(),
        description: z.string().nullable(),
        date: z.string().nullable(),
        publisher: z.string().nullable(),
        npmUrl: z.string(),
        repositoryUrl: z.string().nullable(),
        installed: z.boolean(),
      }),
    ),
  })
  .openapi("PluginCatalog");

const view = (p: PluginRecord) => {
  const { dir: _dir, settingsFields, ...rest } = p;
  return {
    ...rest,
    spec: p.source === "installed" ? installedSpec(p.name) : null,
    hasSettings: settingsFields.length > 0,
    settingsMissing: missingSettings(p),
  };
};

async function state() {
  const plugins = listPlugins().map(view);
  return { plugins, apiVersion: PLUGIN_API_VERSION, canInstall: Boolean(await npmAvailable()), restartRequired: plugins.some((p) => p.restartRequired) };
}

/** Installing only accepts packages that are Yaypost plugins for this API version. */
function validate(dir: string): void {
  const m = readManifest(dir);
  if (m.yaypost.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`it is written for plugin API ${m.yaypost.apiVersion}; this Yaypost provides ${PLUGIN_API_VERSION}`);
  }
}

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
      "Every platform and approval chat is a plugin (built-in ones in plugins/, more from <DATA_DIR>/plugins/, yaypost.config.json plugins.load, " +
      "or installed here). Each entry says what it provides, or why it didn't load.",
    responses: { 200: json(PluginsSchema, "Plugins in load order.") },
  }),
  async (c) => c.json(await state(), 200),
);

pluginRoutes.openapi(
  createRoute({
    method: "get",
    path: "/plugins/catalog",
    tags,
    operationId: "searchPluginCatalog",
    summary: "Browse plugins on npm",
    description: `npm packages with the "${PLUGIN_KEYWORD}" keyword, optionally matching \`q\`. Read before installing: anyone can publish to npm.`,
    request: { query: z.object({ q: z.string().max(100).optional() }) },
    responses: { 200: json(CatalogSchema, "Matching packages."), 409: E409 },
  }),
  async (c) => {
    const installed = new Set(listPlugins().map((p) => p.name));
    const packages = (await searchCatalog(c.req.valid("query").q ?? "")).map((p) => ({ ...p, installed: installed.has(p.name) }));
    return c.json({ keyword: PLUGIN_KEYWORD, packages }, 200);
  },
);

pluginRoutes.openapi(
  createRoute({
    method: "post",
    path: "/plugins/install",
    tags,
    operationId: "installPlugin",
    summary: "Install a plugin from npm or git",
    description:
      "`spec`: an npm package name (optionally @version), github:user/repo, git+https://… or an https://….tgz link. Installed with npm into " +
      "<DATA_DIR>/plugin-packages with install scripts disabled, checked to be a Yaypost plugin for this API version, then loaded at once " +
      "(no restart). The plugin runs with the server's full access to posts and credentials: install only code you trust. Owner only.",
    request: { body: body(z.object({ spec: z.string().min(1).max(500) })) },
    responses: { 200: json(z.object({ plugin: PluginSchema }).extend(PluginsSchema.shape), "Installed (check `plugin.error`)."), 400: E400, 403: E403, 409: E409 },
  }),
  async (c) => {
    requireOwner("install plugins");
    const { spec } = c.req.valid("json");
    const { dir } = await installPackage(spec, validate);
    const plugin = view(await addInstalled(dir));
    audit("plugin.installed", null, `${plugin.name}@${plugin.version} from ${spec}${plugin.error ? ` (not loaded: ${plugin.error})` : ""}`);
    return c.json({ plugin, ...(await state()) }, 200);
  },
);

pluginRoutes.openapi(
  createRoute({
    method: "post",
    path: "/plugins/install-file",
    tags,
    operationId: "installPluginFile",
    summary: "Install a plugin from a .tgz file",
    description: "multipart/form-data with field `file`: a package made with `npm pack` (≤ 20 MB). Same checks and loading as /plugins/install. Owner only.",
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({ file: z.instanceof(File, { message: "attach the .tgz as multipart field `file`" }).openapi({ type: "string", format: "binary" }) }),
          },
        },
      },
    },
    responses: { 200: json(z.object({ plugin: PluginSchema }).extend(PluginsSchema.shape), "Installed (check `plugin.error`)."), 400: E400, 403: E403, 409: E409 },
  }),
  async (c) => {
    requireOwner("install plugins");
    const { file } = c.req.valid("form");
    const { dir } = await installTarball(file, validate);
    const plugin = view(await addInstalled(dir));
    audit("plugin.installed", null, `${plugin.name}@${plugin.version} from file ${file.name}${plugin.error ? ` (not loaded: ${plugin.error})` : ""}`);
    return c.json({ plugin, ...(await state()) }, 200);
  },
);

for (const [path, summary, description] of [
  ["enable", "Switch a plugin on", "Loads it now (its platforms and chats appear at once) and remembers the choice. Owner only."],
  ["disable", "Switch a plugin off", "Unregisters its platforms and chats now (posts to them fail until it is on again) and remembers the choice. Owner only."],
  ["update", "Update an installed plugin", "Installs the latest version from npm (git/file installs are fetched again). Restart Yaypost to run the new code. Owner only."],
  ["uninstall", "Uninstall a plugin", "Only plugins installed from the UI/API. Unregisters it now and removes the package. Owner only."],
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
      if (path === "enable" || path === "disable") await setPluginEnabled(name, path === "enable");
      else if (path === "update") await addInstalled((await updatePackage(name, validate)).dir);
      else {
        removeInstalled(name);
        await uninstallPackage(name);
      }
      audit(`plugin.${path === "enable" ? "enabled" : path === "disable" ? "disabled" : path === "update" ? "updated" : "uninstalled"}`, null, name);
      return c.json(await state(), 200);
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

pluginRoutes.openapi(
  createRoute({
    method: "post",
    path: "/system/restart",
    tags,
    operationId: "restartServer",
    summary: "Restart Yaypost",
    description:
      "Exits the process (code 75) once the response is sent, so a supervisor starts it again: Docker (restart: unless-stopped), systemd (Restart=on-failure), " +
      "pm2… Without one, Yaypost stays stopped. In-flight publishes are finished first. Owner only.",
    responses: { 202: json(z.object({ restarting: z.literal(true) }), "Restarting."), 403: E403 },
  }),
  (c) => {
    requireOwner("restart Yaypost");
    audit("system.restart", null, actorLabel());
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300).unref();
    process.exitCode = 75;
    return c.json({ restarting: true as const }, 202);
  },
);
