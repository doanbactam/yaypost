# Yaypost plugins

Every platform Yaypost publishes to (X, Bluesky, Mastodon, Threads, LinkedIn, Telegram, Discord) and every
approval chat (Telegram, Discord) is a **plugin**. The built-in ones live in `plugins/` and use exactly the same format
and API as third-party ones; nothing in the core knows a platform by name. The design follows
[pi](https://pi.dev)'s extensions: a plugin is an ordinary package directory with a manifest in `package.json`, and an
entry module whose default export receives one API object.

## Anatomy

```
yaypost-plugin-foo/
  package.json
  index.ts          (or index.js)
```

```json
{
  "name": "yaypost-plugin-foo",
  "version": "1.0.0",
  "description": "Publish to Foo",
  "type": "module",
  "keywords": ["yaypost-plugin"],
  "yaypost": { "apiVersion": 1, "entry": "index.ts" },
  "peerDependencies": { "yaypost": "*" }
}
```

```ts
import type { YaypostAPI } from "yaypost/plugin";

export default function (ts: YaypostAPI) {
  ts.registerPlatform({ id: "foo", name: "Foo", /* … see below */ });
}
```

Rules:

- **Types only from Yaypost.** Import types from `yaypost/plugin` (`server/plugin-api.ts`). Everything used at
  runtime comes from the `ts` object: errors, media, storage, settings, env, logging. A plugin never imports server
  internals, so it keeps working across releases that keep the same `apiVersion`.
- **`apiVersion`** is checked on load. It changes only on breaking changes; a plugin built for another version is
  skipped with a clear error instead of failing at runtime.
- **TypeScript runs as is** (the server runs on `tsx`); no build step. Plain `.js` works too.
- **Own dependencies** go in the plugin's `dependencies` (install them in the plugin folder). `yaypost` stays a
  peer dependency.
- **The factory may be async but must not start long-lived work** (timers, sockets, polling). Channels do that in
  `start()` and undo it in `stop()`.
- **All or nothing.** If the factory throws, whatever it registered is removed and the plugin is reported as failed.
  A failing plugin never stops the server.
- **Trust.** Plugins run with the server's full permissions and can read every post and credential they're handed.
  Load only code you have read or trust.

## Installing from the UI

The **Plugins** page (or the API under `/api/plugins`, owner only; agents get 403) works like `pi install`:

- **Discover** searches npm for packages with the `yaypost-plugin` keyword.
- **Install** takes an npm name (optionally `@version`), `github:user/repo`, a `git+https://` URL, an `https://….tgz` link, or an uploaded `.tgz` (from `npm pack`).
- **How it installs:** packages go into `<DATA_DIR>/plugin-packages` (a private npm project pinned to exact versions) with **install scripts disabled**. Yaypost checks that the package is a plugin for its `apiVersion`, rolls back if not, and loads it at once without a restart.
- **On/off** takes effect immediately and is remembered.
- **Update** installs the newest version; a restart is needed to run the new code, and the page offers it.
- **Uninstall** removes the package.
- **Restart** exits with code 75 so a supervisor brings the server back: Docker `restart: unless-stopped`, systemd `Restart=on-failure`, pm2. Without one, the server stays stopped.
- Every change is written to the audit log.

## Where plugins come from

Loaded at startup, in this order:

1. `plugins/*` inside Yaypost (built-in).
2. `<DATA_DIR>/plugins/*`: drop a plugin folder there (it survives upgrades and lives next to your data).
3. `yaypost.config.json` → `plugins.load`: paths relative to the config file, or names of packages installed in
   Yaypost's `node_modules` (`pnpm add yaypost-plugin-foo`).
4. Packages installed from the Plugins page.

```json
"plugins": {
  "load": ["./my-plugins/foo", "yaypost-plugin-bar"],
  "disable": ["discord", "telegram-approvals"],
  "settings": { "yaypost-plugin-foo": { "region": "eu" } }
}
```

- `disable` takes plugin names (the whole plugin) or platform/channel ids (just that one).
- `settings["<plugin name>"]` is what `ts.settings()` returns.
- Ids must be unique: the first plugin to register an id keeps it, and a later one fails to load with a message
  saying so. To replace a built-in, disable it first.

`GET /api/plugins` (and the Plugins page) lists every plugin with its version, its source, what it provides, and why
it failed if it did. Plugins added to folders or to the config are picked up on restart.

## A platform

`ts.registerPlatform(definition)`: the definition is data plus three functions.

| Field | Meaning |
|---|---|
| `id`, `name` | Stable id stored with accounts (lowercase, digits, dashes) and display name. |
| `maxChars`, `maxCharsWithMedia?` | Default limit per item (an account can override it), and a lower limit for an item that has images (Telegram captions). |
| `maxImages`, `imageTypes?`, `maxImageBytes?` | What the platform accepts. Yaypost checks these before anything is posted. |
| `threadMode` | `replies` (a reply chain), `single` (the thread is joined into one post) or `messages` (consecutive messages). |
| `counting` | How it counts characters, **as data**: `{method:"x-weighted"}`, `{method:"graphemes"}` or `{method:"codepoints", urlLength?, emoji?:"utf8-bytes"}`. The web counters, CLI, agents and pre-flight checks all count from this, without running plugin code. |
| `credentials` | The fields the person fills in to connect an account (`key`, `label`, `secret`, `optional?`, `placeholder?`, `help?`). Stored encrypted and never returned. |
| `setup`, `costNote` | One line each: where to get the credentials, and what it costs or requires. |
| `metricsNote?`, `metricsPaid?` | Explain metrics costs; `metricsPaid: true` means `metrics()` is called only when the caller passes `paid=true`. |
| `brand?` | `{ color, iconPath? }` for the UI (24×24 SVG path). |
| `verify(credentials)` | A cheap authenticated call. Returns `{ handle, profileUrl }`, or throws `ts.PlatformError`. |
| `publish(ctx)` | Posts `ctx.items` in order and resumes after `ctx.posted`. Calls `ctx.record(ids)` after **every** item (it is saved at once, so a crash never re-posts). Returns `{ ids, url }`. |
| `metrics?(ctx)` | Optional, read-only engagement per posted id. |

Yaypost does the rest the same way for every platform:
- shapes the thread for the platform (`single` joins it);
- checks lengths, image counts, types and sizes before posting;
- keeps progress per destination, resumes on Retry and locks items that are already live;
- applies the approval gate and the kill switch;
- writes the audit log, marks account errors (on a 401/403 `PlatformError`), handles idempotency, retries and webhooks.

Errors: `throw new ts.PlatformError(message, status?, resumable = true)`.
- The message should tell the person what to do.
- Set `resumable: false` when Retry must not continue after the items already posted (for example, the post being replied to is gone).
- Don't add "N of M are live" yourself; the core appends it.

Images: `ts.media.get(id)` (mime, size, alt), `ts.media.read(id)` (bytes), and `ts.media.publicUrl(id)` (a signed URL valid for an hour, for platforms that fetch images by URL; check `ts.host().publicUrlIsSet`).

## Settings and secrets

A plugin declares its settings **as data** in `package.json`, and the Plugins page renders a form from them without running plugin code:

```json
"yaypost": {
  "apiVersion": 1,
  "settings": [
    { "key": "botToken", "label": "Bot token", "secret": true, "required": true, "env": "FOO_BOT_TOKEN", "help": "From …" },
    { "key": "region", "label": "Region", "default": "eu" },
    { "key": "maxChars", "label": "Limit", "type": "number", "default": 10000 }
  ]
}
```

- **Field types:** `type` is `string` (default), `text` (multi-line), `number` or `boolean`.
- **Secrets** (`secret: true`) are stored encrypted (AES-256-GCM, like account credentials). They are never sent back to the browser; the page only shows whether one is set and where it comes from.
- **Required fields:** `required` fields with no value mark the plugin "Needs setup".
- **Reading values:** `ts.settings()` returns the effective value of each field, taking the first of these that is set:
  1. the value saved on the Plugins page;
  2. `yaypost.config.json` → `plugins.settings["<plugin name>"]`;
  3. the field's `env` variable;
  4. its `default`.

  Read it when you need a value rather than caching it.
- **Saving** reloads the plugin at once: its factory runs again and its chats restart.
- **Access:** only the owner can read or change settings (`GET`/`POST /api/plugins/settings`), and every change is audited (keys only, never values).

## An approval channel

`ts.registerChannel(definition)` adds a chat where the person gets approval requests, alerts and the daily digest.
See `plugins/telegram-approvals` and `plugins/discord-approvals`.

- `configured()`: whether it has what it needs, usually env variables read with `ts.env(...)`. Unconfigured channels are never started.
- `start(handlers)` / `stop()`: begin and end receiving (long polling, a gateway…).
- `send({ text, buttons })` returns a ref; `finalize(ref, text)` replaces the text and removes the buttons once the request is decided.
- When the person acts, call `handlers.act(who, "approve" | "reject" | "changes" | "pause" | "resume", postId, note?)`. For text commands, call `handlers.command(who, "pending" | "status" | "pause" | "resume" | "run", arg)`. The channel must check that the person is allowed to decide before it calls either.

## Other API

| | |
|---|---|
| `ts.on(listener)` | Every state change (post created/approved/published/failed…, publishing paused), read-only. Returns an unsubscribe function. |
| `ts.store.get/set` | Small persistent JSON store private to the plugin (cursors, caches). |
| `ts.settings()` | `plugins.settings["<plugin name>"]` from the config. |
| `ts.env(name)` | An environment variable, trimmed (`.env` is already loaded). |
| `ts.host()` | `{ timezone, maxChars, publicUrl, publicUrlIsSet }`. |
| `ts.log.info/warn/error` | Prefixed with the plugin name. |

## Example

`examples/plugin-webhook` is a complete third-party platform plugin in about 70 lines: it POSTs each item as JSON to
an endpoint (n8n, Zapier, your own service). Try it with `"plugins": { "load": ["./examples/plugin-webhook"] }`, then
connect a "Webhook" account in the Agents page.

## Publishing your plugin

Add the `yaypost-plugin` keyword and publish it to npm (`npm publish`). It then shows up in every Yaypost's
Discover tab. Keep `yaypost` as a peer dependency.

## Not (yet) provided

- **No hot reload of changed code.** Updates need a restart (switching plugins on and off, installing and uninstalling don't).
- **No sandboxing.** Plugins are trusted code.
