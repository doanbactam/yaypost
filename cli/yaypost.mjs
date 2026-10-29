#!/usr/bin/env node
// yaypost — command-line client for a Yaypost server (REST API). Plain ESM, zero dependencies, Node ≥ 20.
// For agents: every command takes --json; exit codes are 0 ok, 1 API or network error (or a publish that ended
// in failed), 2 usage error.
import { spawnSync } from "node:child_process";
import { fstatSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseArgs } from "node:util";

const BASE = (process.env.YAYPOST_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const TOKEN = process.env.YAYPOST_TOKEN;

const HELP = `yaypost — draft, queue and publish posts and threads (X, Bluesky, Mastodon, Threads, LinkedIn, Telegram,
Discord) on your Yaypost server

Usage: yaypost <command> [args] [--json]

Posts
  new [text] [--file f|-] [--at next|time] [--to ref,ref] [--version ref=file]... [--image [N:]path]... [--title t]
                              Create a draft (or schedule it with --at). Posts are separated by a line "---".
                              --to sends it to connected accounts (see accounts); without it the post can only
                              be a draft.
                              --version gives one destination its own text (posts separated by ---).
                              --image attaches to post N (default 1); repeat for more images.
  queue [--days 7]            Day-by-day timeline with scheduled posts, their destinations and free slots
  list [--status s,s]         Posts, newest first (draft, scheduled, due, publishing, published, failed)
  show <id>                   One post in full, with per-post counts and each destination's status
  preview <id>                What each destination will publish, counted its way, and what would stop it
  edit <id> [text] [--file f|-] [--title t] [--to ref,ref|none] [--version ref=file|ref=none]...
                              Replace the text (images stay with their post), the destinations or a
                              destination's version (none = use the main text); --title alone renames
  schedule <id> <next|time>   Queue for the next free slot or a time
  unschedule <id>             Back to drafts
  publish <id>                Publish now to every destination; exit 1 if any failed
  retry <id>                  Retry a failed post or publish a due one; threads resume where they stopped
  copy <id> [--clipboard]     Print the thread (or copy it) to post by hand
  posted <id> [--url u]       Mark as posted by hand
  append <id> [text|--file f] [--at next|ISO]
                              Continue a published thread (replies to the last live post on each destination)
  metrics [<id>] [-r] [--paid] [--limit n]
                              Engagement: one post (-r fetches fresh numbers; --paid allows billed X reads),
                              or the recent published posts with stored totals (for agents to analyse)
  rm <id>                     Delete
  slots [n]                   Next free posting slots
  count [text|--file f] [--platform p] [--max n]
                              Count characters the way a platform does (default x; offline: the built-in platforms)

Accounts
  accounts                    Connected accounts (connect them in the web UI: it needs your secrets)
  accounts check <ref>        Re-verify an account's stored credentials
  platforms                   Platforms the server's plugins provide: limits, counting, images, cost

  An account ref is its id (or a unique id prefix), its label, its handle, or a platform name when only one
  account of that platform is connected.

Approvals (agents queue, the person decides)
  reviews                     Posts waiting for the person, and posts sent back with changes (and the note)
  approve <id> [--note n]     Approve: it goes out at its time (now if that passed)      } need the owner token
  reject <id> [--note n]      Reject: back to drafts                                     } (AUTH_TOKEN with an
  changes <id> <note>         Send back to the agent with what to change                } AGENT_TOKEN set)
  pause [reason]              Stop all publishing until resumed (anyone may pause)
  resume                      Resume publishing (owner)
  audit [--limit n]           Who did what, newest first
  feedback [--limit n]        What the person said when sending back, rejecting or approving: follow it in new drafts
  digest                      The daily digest, now

Other
  health                      Server status: version, paused, timezone
  help                        This help

Ids can be shortened to any unique prefix. Text can also come from stdin, e.g.
  cat thread.txt | yaypost new --at next --to bluesky,mastodon

Times are shown in the server's timezone (yaypost health), and a time you type is read there too unless it
has an offset: 2026-11-03T09:00 is 09:00 in that zone; 2026-11-03T09:00+07:00 or ...Z is exact.

Environment: YAYPOST_URL (default http://127.0.0.1:3000), YAYPOST_TOKEN (the server's AUTH_TOKEN).
Exit codes: 0 ok, 1 API or network error (or publish/retry ended in failed), 2 usage error.`;

class UsageError extends Error {}
class ApiError extends Error {}

// ---------- X's weighted character count (mirrors shared/thread.ts) ----------

const LIGHT = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
// A URL is ASCII/Latin/Cyrillic only (it ends before CJK text) and trailing punctuation is not part of it.
const URL_CHARS = "[\\w\\-.~!*';:=+,$/%#\\[\\]&|@?()\\u00C0-\\u024F\\u0400-\\u04FF\\u1E00-\\u1EFF]";
const URL_RE = new RegExp(
  `\\bhttps?:\\/\\/${URL_CHARS}+|(?<![\\w@./:-])(?:[a-z0-9-]+\\.)+(?:com|net|org|io|ai|dev|app|co|me|xyz|vn|gg|so|sh|tv|ly|to|us|uk|de|fr|jp)\\b(?:\\/${URL_CHARS}*)?`,
  "gi",
);
const TRAILING_PUNCT = /[.,!?;:'")\]]+$/;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter();

function plainWeight(text) {
  let total = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI_RE.test(segment)) total += 2;
    else for (const ch of segment) total += LIGHT.some(([lo, hi]) => ch.codePointAt(0) >= lo && ch.codePointAt(0) <= hi) ? 1 : 2;
  }
  return total;
}

function weightedLength(raw) {
  const text = raw.normalize("NFC");
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT, "");
    total += plainWeight(text.slice(last, m.index)) + 23;
    last = m.index + url.length;
  }
  return total + plainWeight(text.slice(last));
}

// ---------- platforms ----------
// Platforms come from plugins on the server (GET /api/platforms), counting rule included, as data. The bundled seven
// are copied here only so `count` keeps working offline; everything else asks the server.

const BUILTIN_PLATFORMS = {
  x: { name: "X", maxChars: 280, threadMode: "replies", counting: { method: "x-weighted" } },
  bluesky: { name: "Bluesky", maxChars: 300, threadMode: "replies", counting: { method: "graphemes" } },
  mastodon: { name: "Mastodon", maxChars: 500, threadMode: "replies", counting: { method: "codepoints", urlLength: 23 } },
  threads: { name: "Threads", maxChars: 500, threadMode: "replies", counting: { method: "codepoints", emoji: "utf8-bytes" } },
  linkedin: { name: "LinkedIn", maxChars: 3000, threadMode: "single", counting: { method: "codepoints" } },
  telegram: { name: "Telegram", maxChars: 4096, threadMode: "messages", counting: { method: "codepoints" } },
  discord: { name: "Discord", maxChars: 2000, threadMode: "messages", counting: { method: "codepoints" } },
};
const URL_ANY = /\bhttps?:\/\/\S+/gi;

/** Characters as a counting rule counts them (mirrors shared/counting.ts countWith; keep in parity). */
function countWith(rule, text) {
  switch (rule?.method) {
    case "graphemes":
      return [...segmenter.segment(text.normalize("NFC"))].length; // links count in full
    case "codepoints": {
      const t = rule.urlLength ? text.replace(URL_ANY, "x".repeat(rule.urlLength)) : text;
      if (rule.emoji !== "utf8-bytes") return [...t].length;
      let n = 0; // an emoji counts as its UTF-8 byte length, everything else per character
      for (const { segment } of segmenter.segment(t)) n += EMOJI_RE.test(segment) ? Buffer.byteLength(segment) : [...segment].length;
      return n;
    }
    default:
      return weightedLength(text); // x-weighted, and the safe guess for a rule this CLI doesn't know yet
  }
}

let platformsPromise;
/** The server's platforms by id (rejects when the server can't be reached). */
const platformsMap = (signal) =>
  (platformsPromise ??= api("GET", "/api/platforms", undefined, undefined, signal).then((d) => {
    knownPlatforms = new Map(d.platforms.map((p) => [p.id, p]));
    return knownPlatforms;
  }));
let knownPlatforms = null;
/** Best effort: names in listings come from the server when it answers. */
const loadPlatforms = () => platformsMap().catch(() => null);
const platformName = (id) => knownPlatforms?.get(id)?.name ?? BUILTIN_PLATFORMS[id]?.name ?? id;

const splitThread = (text) =>
  text
    .split(/^\s*-{3,}\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
const joinThread = (parts) => parts.map((p) => p.trim()).join("\n\n---\n\n");

// ---------- plumbing ----------

let opt;
let positionals;
try {
  ({ values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      file: { type: "string", short: "f" },
      at: { type: "string" },
      image: { type: "string", multiple: true },
      title: { type: "string" },
      days: { type: "string" },
      status: { type: "string" },
      clipboard: { type: "boolean", short: "c" },
      url: { type: "string" },
      count: { type: "string" },
      max: { type: "string" },
      note: { type: "string" },
      to: { type: "string" },
      version: { type: "string", multiple: true },
      platform: { type: "string", short: "p" },
      refresh: { type: "boolean", short: "r" },
      paid: { type: "boolean" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (err) {
  fail(new UsageError(err.message));
}

async function api(method, path, body, form, signal) {
  const headers = { accept: "application/json", "x-yaypost-source": "cli" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)), signal });
  } catch (err) {
    if (err.cause?.code === "UND_ERR_HEADERS_TIMEOUT") {
      throw Object.assign(new ApiError(`Yaypost at ${BASE} took too long to answer (no response after 5 minutes).`), { code: "timeout" });
    }
    throw Object.assign(new ApiError(`Can't reach Yaypost at ${BASE} (${err.cause?.code ?? err.message}). Is the server running? Set YAYPOST_URL.`), {
      code: "unreachable",
    });
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!res.ok) {
    const hint = res.status === 401 ? " (set YAYPOST_TOKEN to the server's AUTH_TOKEN)" : "";
    throw Object.assign(new ApiError(`${data.message ?? res.statusText}${hint}`), { status: res.status, code: data.error });
  }
  return data;
}

function readFile(path, encoding) {
  try {
    return readFileSync(path === "-" ? 0 : path, encoding);
  } catch (err) {
    throw new UsageError(`Can't read ${path}: ${err.code ?? err.message}`);
  }
}

/** Text from --file, the remaining arguments, or piped stdin. */
function readText(args) {
  if (opt.file) return readFile(opt.file, "utf8");
  if (args.length) return args.join(" ");
  const stdin = fstatSync(0);
  if (stdin.isFIFO() || stdin.isFile()) return readFileSync(0, "utf8");
  throw new UsageError("Give the text as an argument, with --file <path> (- for stdin), or pipe it in.");
}

async function resolveId(ref) {
  if (!ref) throw new UsageError("Missing post id.");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  const { posts } = await api("GET", "/api/posts?limit=1000");
  const hits = posts.filter((p) => p.id.startsWith(ref));
  if (hits.length === 1) return hits[0].id;
  throw new ApiError(hits.length ? `"${ref}" matches ${hits.length} posts; use more characters.` : `No post id starts with "${ref}".`);
}

// ---------- destinations ----------

let accountsPromise;
const accountsList = () => (accountsPromise ??= Promise.all([api("GET", "/api/accounts"), loadPlatforms()]).then(([d]) => d.accounts));
const describeAccount = (a) => `${a.label} (${platformName(a.platform)}${a.handle ? ` ${a.handle}` : ""}, ${short(a.id)})`;

/** Same rules as the MCP tools: id, id prefix, label, handle, or a platform name with exactly one account. */
function resolveAccount(ref, accounts) {
  const r = ref.trim().toLowerCase();
  const exact = accounts.find((a) => a.id.toLowerCase() === r);
  if (exact) return exact;
  const strong = accounts.filter(
    (a) => a.label.toLowerCase() === r || (a.handle && a.handle.toLowerCase().replace(/^@/, "") === r.replace(/^@/, "")) || (r.length >= 4 && a.id.startsWith(r)),
  );
  if (strong.length === 1) return strong[0];
  const ids = new Set([...(knownPlatforms?.keys() ?? Object.keys(BUILTIN_PLATFORMS)), ...accounts.map((a) => a.platform)]);
  const platform = [...ids].find((p) => p === r || platformName(p).toLowerCase() === r);
  const matches = strong.length ? strong : platform ? accounts.filter((a) => a.platform === platform) : [];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new UsageError(`"${ref}" matches ${matches.length} accounts; use an id or label: ${matches.map(describeAccount).join("; ")}`);
  if (!accounts.length) throw new UsageError(`No accounts are connected, so "${ref}" can't be a destination. Connect accounts in the web UI.`);
  throw new UsageError(`No connected account matches "${ref}". Connected: ${accounts.map(describeAccount).join("; ")}`);
}

/** --version ref=file pairs → [{account, value}] where value is the text, or null for "none". */
async function versionSpecs() {
  const out = [];
  for (const spec of opt.version ?? []) {
    const m = /^([^=]+)=(.*)$/.exec(spec);
    if (!m) throw new UsageError(`--version ${spec}: use ref=file (or ref=none to drop a version).`);
    const account = resolveAccount(m[1], await accountsList());
    out.push({ account, value: m[2] === "none" ? null : readFile(m[2], "utf8") });
  }
  return out;
}

/** A version's segments: images carry over by position from `base` (extra images go on its last post). */
function versionThread(text, base) {
  const parts = splitThread(text);
  if (!parts.length) throw new UsageError("A --version file is empty.");
  return parts.map((t, i) => ({ text: t, mediaIds: i === parts.length - 1 ? base.slice(i).flatMap((s) => s.mediaIds ?? []) : (base[i]?.mediaIds ?? []) }));
}

/** --to and --version → the `targets` body field, or undefined to leave destinations as they are. */
async function targetsFrom(current, sharedThread) {
  if (opt.to === undefined && !opt.version?.length) return undefined;
  const accounts = opt.to !== undefined || opt.version?.length ? await accountsList() : [];
  const ids =
    opt.to === undefined
      ? (current?.targets ?? []).map((t) => t.accountId)
      : opt.to.trim() === "none" || opt.to.trim() === ""
        ? []
        : opt.to.split(",").map((r) => resolveAccount(r, accounts).id);
  if (new Set(ids).size !== ids.length) throw new UsageError("--to names the same account twice.");
  const targets = ids.map((accountId) => ({ accountId })); // no `thread`: the server keeps an existing version
  for (const { account, value } of await versionSpecs()) {
    const t = targets.find((x) => x.accountId === account.id);
    if (!t) throw new UsageError(`--version: ${describeAccount(account)} is not a destination; add it to --to.`);
    const previous = current?.targets.find((x) => x.accountId === account.id)?.thread;
    t.thread = value === null ? null : versionThread(value, previous ?? sharedThread);
  }
  if (!current) for (const t of targets) t.thread ??= null;
  return targets;
}

function targetLine(t, accounts) {
  const a = accounts.find((x) => x.id === t.accountId);
  const name = a ? describeAccount(a) : `${t.platform} ${short(t.accountId)}`;
  const detail = t.url ? ` ${t.url}` : t.error ? ` — ${t.error}` : t.externalIds.length ? ` (${t.externalIds.length} live)` : "";
  return `${t.status.padEnd(9)} ${name}${t.thread ? " [own version]" : ""}${detail}`;
}

/** After saving: what would stop each destination (server preview). */
async function warnProblems(post) {
  if (!post.targets?.length) return console.error("warning: no destinations yet; add some with --to before scheduling or publishing");
  const { targets } = await api("GET", `/api/posts/${post.id}/preview`);
  for (const t of targets) if (t.problem) console.error(`warning: ${t.label}: ${t.problem}`);
}

const int = (v, name, fallback) => {
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) throw new UsageError(`${name} must be a whole number.`);
  return Number(v);
};
let serverConfigPromise;
/** GET /api/config (timezone, configError), fetched once; null if the server can't be asked (`count` works offline). */
function serverConfig() {
  serverConfigPromise ??= fetch(`${BASE}/api/config`, {
    signal: AbortSignal.timeout(3000),
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return serverConfigPromise;
}

// Times are shown in the server's configured timezone, the zone it reads offset-less input in, so a time shown
// here can be typed back as-is. Falls back to this machine's zone (and says so) if the config can't be read.
let TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function useServerTimezone(tz) {
  TZ = tz ?? (await serverConfig())?.timezone ?? TZ;
}

const when = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "";
const whenTz = (iso) => `${when(iso)} ${TZ}`;
const hhmm = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD in TZ
const short = (id) => id.slice(0, 8);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const firstLine = (p) => clip((p.thread[0]?.text ?? "").split("\n")[0], 60);

function emit(data, human) {
  if (opt.json) console.log(JSON.stringify(data, null, 2));
  else human(data);
}

function line(p) {
  const to = p.targets?.length ? `→ ${p.targets.map((t) => platformName(t.platform)).join(",")} ` : "";
  return `${short(p.id)}  ${p.status.padEnd(10)} ${(when(p.scheduledAt) || "—").padEnd(22)} ${to}${p.title ? `[${p.title}] ` : ""}${firstLine(p)}`;
}

function printPost(p) {
  console.log(`${p.id}  ${p.status}${p.scheduledAt ? `  ${whenTz(p.scheduledAt)}` : ""}${p.title ? `  [${p.title}]` : ""}`);
  p.thread.forEach((s, i) => {
    console.log(`\n[${i + 1}]${s.mediaIds.length ? `  images: ${s.mediaIds.length}` : ""}`);
    console.log(s.text.replace(/^/gm, "  "));
  });
  if (p.url) console.log(`\nurl: ${p.url}`);
  if (p.error) console.log(`\nerror: ${p.error}`);
}

function status(p) {
  const extra = p.status === "scheduled" ? ` for ${whenTz(p.scheduledAt)}` : p.url && !p.targets?.length ? ` ${p.url}` : p.error ? ` — ${p.error}` : "";
  console.log(`${short(p.id)} ${p.status}${extra}`);
  for (const t of p.targets ?? []) {
    if (p.status === "scheduled" && t.status === "pending") continue;
    console.log(`  ${platformName(t.platform).padEnd(9)} ${t.status}${t.url ? ` ${t.url}` : t.error ? ` — ${t.error}` : ""}`);
  }
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function upload(path) {
  const type = MIME[extname(path).toLowerCase()];
  if (!type) throw new UsageError(`${path}: use a .png, .jpg, .webp or .gif image.`);
  const form = new FormData();
  form.set("file", new Blob([readFile(path)], { type }), basename(path));
  return api("POST", "/api/media", undefined, form);
}

function copyToClipboard(text) {
  const tools =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"], ["clip.exe"]];
  for (const [cmd, ...args] of tools) {
    const r = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (!r.error && r.status === 0) return cmd;
  }
  return null;
}

// ---------- commands ----------

const commands = {
  async new(args) {
    const parts = splitThread(readText(args));
    if (!parts.length) throw new UsageError("The post is empty.");
    const media = parts.map(() => []);
    for (const spec of opt.image ?? []) {
      const m = /^(\d+):(.+)$/.exec(spec);
      const [n, path] = m ? [Number(m[1]), m[2]] : [1, spec];
      if (n < 1 || n > parts.length) throw new UsageError(`--image ${spec}: the thread has ${parts.length} post(s).`);
      media[n - 1].push((await upload(path)).id);
    }
    const thread = parts.map((text, i) => ({ text, mediaIds: media[i] }));
    const targets = await targetsFrom(undefined, thread);
    const post = await api("POST", "/api/posts", { thread, title: opt.title, scheduledAt: opt.at, targets });
    if (!opt.json) await useServerTimezone();
    const to = post.targets.length ? ` → ${post.targets.length} destination${post.targets.length > 1 ? "s" : ""}` : " (no destinations)";
    emit(post, (p) => console.log(`${p.scheduledAt ? `Scheduled ${short(p.id)} for ${whenTz(p.scheduledAt)}` : `Saved draft ${short(p.id)}`} (${p.thread.length} post${p.thread.length > 1 ? "s" : ""})${to}`));
    await warnProblems(post);
  },

  async queue() {
    const q = await api("GET", `/api/queue?days=${int(opt.days, "--days", 7)}`);
    if (!opt.json) await loadPlatforms();
    await useServerTimezone(q.timezone);
    emit(q, () => {
      const days = q.days.filter((d) => d.items.length);
      if (!days.length) return console.log("Nothing scheduled and no free slots in this range.");
      console.log(`Times in ${TZ}`);
      for (const { date, items } of days) {
        console.log(new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }));
        for (const { at, post } of items.filter((i) => i.type === "post")) {
          // Overdue due/failed posts from earlier days are listed under today: show their own date.
          const time = dayKey(at) === date ? hhmm(at) : `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: TZ })} ${hhmm(at)}`;
          console.log(`  ${time}  ${post.status.padEnd(10)} ${short(post.id)}  ${firstLine(post)}`);
          for (const t of post.targets ?? []) {
            console.log(`         ${" ".repeat(time.length - 5)}↳ ${platformName(t.platform).padEnd(9)} ${t.status}${t.error ? ` — ${clip(t.error, 80)}` : ""}`);
          }
        }
        const free = items.filter((i) => i.type === "slot").map((i) => hhmm(i.at));
        if (free.length) console.log(`  free: ${free.join(", ")}`);
      }
    });
  },

  async list() {
    const qs = new URLSearchParams({ limit: "50" });
    if (opt.status) qs.set("status", opt.status);
    const data = await api("GET", `/api/posts?${qs}`);
    if (!opt.json) await loadPlatforms();
    if (!opt.json) await useServerTimezone();
    emit(data, ({ posts }) => {
      if (posts.some((p) => p.scheduledAt)) console.log(`Times in ${TZ}`);
      console.log(posts.length ? posts.map(line).join("\n") : "No posts.");
    });
  },

  async show([ref]) {
    const post = await api("GET", `/api/posts/${await resolveId(ref)}`);
    if (!opt.json) await useServerTimezone();
    const accounts = !opt.json && post.targets.length ? await accountsList() : [];
    emit(post, (p) => {
      printPost(p);
      console.log(p.targets.length ? `\ndestinations:\n${p.targets.map((t) => `  ${targetLine(t, accounts)}`).join("\n")}` : "\ndestinations: none");
    });
  },

  async preview([ref]) {
    const data = await api("GET", `/api/posts/${await resolveId(ref)}/preview`);
    if (!opt.json) await loadPlatforms();
    emit(data, ({ targets }) => {
      for (const t of targets) {
        const mode = t.threadMode === "single" && t.items.length === 1 ? ", joined into one post" : "";
        console.log(`${t.label} — ${platformName(t.platform)}, limit ${t.limit}${mode}, ${t.status}${t.live ? `, ${t.live} live` : ""}`);
        t.items.forEach((it, i) => console.log(`  [${i + 1}] ${it.count}/${t.limit}${it.fits ? "" : " OVER"}${it.images ? `  images: ${it.images}` : ""}  ${clip(it.text.replace(/\s+/g, " "), 60)}`));
        console.log(t.problem ? `  problem: ${t.problem}` : "  ready");
      }
    });
    if (data.targets.some((t) => t.problem)) process.exitCode = 1;
  },

  async edit([ref, ...rest]) {
    const id = await resolveId(ref);
    // A title-only rename never reads stdin: in a `while read` loop or under xargs it holds other input, not the text.
    const onlyMeta = opt.title !== undefined || opt.to !== undefined || opt.version?.length;
    const text = opt.file || rest.length || !onlyMeta ? readText(rest) : undefined;
    if (text !== undefined && !splitThread(text).length) throw new UsageError("The post is empty.");
    const current = opt.to !== undefined || opt.version?.length ? await api("GET", `/api/posts/${id}`) : undefined;
    const targets = current ? await targetsFrom(current, current.thread) : undefined;
    // `text` keeps each post's id and images by position (the server maps them).
    const post = await api("PATCH", `/api/posts/${id}`, { title: opt.title, text, targets });
    emit(post, (p) => console.log(`Updated ${short(p.id)} (${p.thread.length} post${p.thread.length > 1 ? "s" : ""}, ${p.targets.length ? `${p.targets.length} destination(s)` : "no destinations"})`));
    await warnProblems(post);
  },

  async schedule([ref, at]) {
    if (!at) throw new UsageError("Usage: yaypost schedule <id> <next|time> (e.g. 2026-11-03T09:00, read in the server's timezone)");
    const post = await api("POST", `/api/posts/${await resolveId(ref)}/schedule`, { at });
    if (!opt.json) await useServerTimezone();
    emit(post, status);
  },
  async unschedule([ref]) {
    emit(await api("POST", `/api/posts/${await resolveId(ref)}/unschedule`), status);
  },
  async publish([ref]) {
    // X errors come back as a post with status failed (HTTP 200); report them through the exit code too.
    const post = await api("POST", `/api/posts/${await resolveId(ref)}/publish`);
    emit(post, status);
    if (post.status === "failed") process.exitCode = 1;
  },
  async retry([ref]) {
    const post = await api("POST", `/api/posts/${await resolveId(ref)}/retry`);
    emit(post, status);
    if (post.status === "failed") process.exitCode = 1;
  },
  async posted([ref]) {
    emit(await api("POST", `/api/posts/${await resolveId(ref)}/mark-published`, { url: opt.url }), status);
  },
  async append([ref, ...rest]) {
    const id = await resolveId(ref);
    const text = readText(rest);
    if (!splitThread(text).length) throw new UsageError("Nothing to append.");
    const post = await api("POST", `/api/posts/${id}/append`, { text, at: opt.at });
    emit(post, (p) => console.log(`Continuing ${short(p.id)}: new posts queued for ${whenTz(p.scheduledAt)}`));
  },

  async metrics([ref]) {
    if (!ref) {
      const data = await api("GET", `/api/metrics?limit=${Number(opt.limit) || 20}`);
      return emit(data, (d) => {
        for (const p of d.posts) {
          const dest = p.destinations.map((t) => `${t.platform} ${t.totals ? Object.entries(t.totals).map(([k, v]) => `${v} ${k}`).join(" ") : "–"}`).join(" · ");
          console.log(`${short(p.id)}  ${when(p.publishedAt)}  ${(p.posts[0] ?? "").slice(0, 50)}\n          ${dest || "no destinations"}`);
        }
      });
    }
    const q = new URLSearchParams({ refresh: String(Boolean(opt.refresh)), paid: String(Boolean(opt.paid)) });
    const data = await api("GET", `/api/posts/${await resolveId(ref)}/metrics?${q}`);
    emit(data, (d) => {
      for (const t of d.post.targets) {
        const m = t.metrics;
        console.log(`${t.platform.padEnd(9)} ${m ? Object.entries(m.totals).map(([k, v]) => `${v} ${k}`).join(", ") + `  (as of ${when(m.fetchedAt)})` : "no numbers yet"}`);
      }
      for (const s of d.skipped) console.error(`${s.platform}: ${s.reason}`);
    });
  },

  async rm([ref]) {
    const id = await resolveId(ref);
    emit(await api("DELETE", `/api/posts/${id}`), () => console.log(`Deleted ${short(id)}`));
  },

  async copy([ref]) {
    const data = await api("GET", `/api/posts/${await resolveId(ref)}/export`);
    const copiedWith = opt.clipboard ? copyToClipboard(data.text) : null;
    emit({ ...data, copied: Boolean(copiedWith) }, () => {
      if (copiedWith) console.log(`Copied ${data.posts.length} post(s) to the clipboard (${copiedWith}).`);
      else {
        if (opt.clipboard) console.error("No clipboard tool found (pbcopy, wl-copy, xclip, xsel, clip.exe); printing instead.");
        console.log(data.text);
      }
    });
  },

  async slots([n]) {
    const data = await api("GET", `/api/slots/next?count=${int(n, "n", 5)}`);
    if (!opt.json) await useServerTimezone();
    emit(data, ({ slots }) => console.log([`Times in ${TZ}`, ...slots.map(when)].join("\n")));
  },

  async count(args) {
    const ref = (opt.platform ?? "x").trim().toLowerCase();
    // The server's list (plugins included); offline, the bundled platforms only.
    let platforms = await platformsMap(AbortSignal.timeout(3000)).catch((err) => {
      if (err.code === "unreachable") return null;
      throw err;
    });
    platforms ??= new Map(Object.entries(BUILTIN_PLATFORMS).map(([id, p]) => [id, { id, ...p }]));
    const info = platforms.get(ref) ?? [...platforms.values()].find((p) => p.name.toLowerCase() === ref);
    if (!info) throw new UsageError(`--platform must be one of: ${[...platforms.keys()].join(", ")}`);
    const platform = info.id;
    const limit = opt.max ? int(opt.max, "--max") : info.maxChars;
    let parts = splitThread(readText(args));
    const joined = info.threadMode === "single" && parts.length > 1;
    if (joined) parts = [parts.join("\n\n")]; // LinkedIn publishes the thread as one post
    const posts = parts.map((text, i) => {
      const chars = countWith(info.counting, text);
      return { post: i + 1, chars, remaining: limit - chars, fits: chars <= limit };
    });
    emit({ platform, limit, joined, allFit: posts.length > 0 && posts.every((p) => p.fits), posts }, () => {
      if (platform !== "x" || joined) console.log(`${info.name}${joined ? " (thread joined into one post)" : ""}`);
      posts.forEach((p) => console.log(`[${p.post}] ${p.chars}/${limit}${p.fits ? "" : `  OVER by ${-p.remaining}`}`));
    });
  },

  async accounts([sub, ref]) {
    if (sub === "check") {
      if (!ref) throw new UsageError("Usage: yaypost accounts check <ref>");
      const a = await api("POST", `/api/accounts/${resolveAccount(ref, await accountsList()).id}/check`);
      emit(a, () => console.log(a.lastError ? `${describeAccount(a)}: ${a.lastError}` : `${describeAccount(a)}: OK`));
      if (a.lastError) process.exitCode = 1;
      return;
    }
    if (sub) throw new UsageError("Usage: yaypost accounts [check <ref>]");
    const accounts = await accountsList();
    emit({ accounts }, () => {
      if (!accounts.length) return console.log("No accounts connected. Connect them in the web UI; until then posts can only be drafts.");
      for (const a of accounts) {
        const limit = a.maxChars ? ` · limit ${a.maxChars}` : "";
        console.log(`${short(a.id)}  ${platformName(a.platform).padEnd(9)} ${a.label}${a.handle ? `  ${a.handle}` : ""}${limit}${a.lastError ? `\n          error: ${a.lastError}` : ""}`);
      }
    });
  },

  async platforms() {
    const data = { platforms: [...(await platformsMap()).values()] };
    const mode = { replies: "reply chain", single: "one joined post", messages: "messages" };
    emit(data, ({ platforms }) => {
      for (const p of platforms) {
        const types = p.imageTypes ? ` (${p.imageTypes.map((t) => t.replace("image/", "")).join("/")})` : "";
        console.log(`${p.id.padEnd(9)} ${String(p.maxChars).padStart(5)} chars · ${p.maxImages} images${types} · ${mode[p.threadMode]} · ${p.costNote}`);
      }
    });
  },

  async reviews() {
    const data = await api("GET", "/api/approvals");
    emit(data, ({ posts }) => {
      if (!posts.length) return console.log("Nothing is waiting on the person.");
      for (const p of posts) {
        const first = (p.title || p.thread[0]?.text || "").split("\n")[0].slice(0, 70);
        const what = p.approval.state === "pending" ? `waiting · ${p.scheduledAt ? when(p.scheduledAt) : "now"}` : `sent back: ${p.approval.note}`;
        console.log(`${short(p.id)}  ${first}\n          ${what} · asked by ${p.approval.by ?? p.source}`);
      }
    });
  },

  async approve([ref]) {
    const p = await api("POST", `/api/posts/${await resolveId(ref)}/approve`, { note: opt.note });
    emit(p, () => console.log(`Approved ${short(p.id)}${p.scheduledAt ? `, goes out ${when(p.scheduledAt)}` : ""}`));
  },

  async reject([ref]) {
    const p = await api("POST", `/api/posts/${await resolveId(ref)}/reject`, { note: opt.note });
    emit(p, () => console.log(`Rejected ${short(p.id)} (back to drafts)`));
  },

  async changes([ref, ...note]) {
    if (!note.length) throw new UsageError('Usage: yaypost changes <id> "what to change"');
    const p = await api("POST", `/api/posts/${await resolveId(ref)}/request-changes`, { note: note.join(" ") });
    emit(p, () => console.log(`Sent ${short(p.id)} back to the agent`));
  },

  async pause(reason) {
    const c = await api("POST", "/api/control/pause", { reason: reason.join(" ") || undefined });
    emit(c, () => console.log(`Publishing paused (by ${c.paused.by}). Nothing goes out until \`yaypost resume\`.`));
  },

  async resume() {
    emit(await api("POST", "/api/control/resume"), () => console.log("Publishing resumed."));
  },

  async audit() {
    const data = await api("GET", `/api/audit?limit=${int(opt.limit, "--limit", 30)}`);
    emit(data, ({ entries }) => {
      for (const e of entries) console.log(`${when(e.at)}  ${e.actor.padEnd(24)} ${e.action.padEnd(24)} ${e.postId ? short(e.postId) : ""} ${e.detail ?? ""}`);
    });
  },

  async feedback() {
    const data = await api("GET", `/api/feedback?limit=${int(opt.limit, "--limit", 30)}`);
    const label = { changes_requested: "changes", rejected: "rejected", approved: "approved" };
    emit(data, ({ feedback }) => {
      if (!feedback.length) return console.log("No feedback yet: nothing has been sent back, rejected or approved with a note.");
      for (const f of feedback) {
        const post = f.post ? `${short(f.postId)}  ${(f.post.title || f.post.preview).split("\n")[0].slice(0, 70)}` : "(deleted post)";
        console.log(`${when(f.at)}  ${label[f.decision].padEnd(8)} ${post}\n          ${f.note ? `"${f.note}"` : "(no note)"}`);
      }
    });
  },

  async digest() {
    emit(await api("GET", "/api/digest"), ({ text }) => console.log(text));
  },

  async health() {
    const h = await api("GET", "/api/health");
    const configError = (await serverConfig())?.configError ?? null;
    emit({ ...h, configError }, () =>
      console.log(
        [
          `Yaypost ${h.version} at ${BASE}`,
          ...(h.paused ? ["Publishing: PAUSED (yaypost resume)"] : []),
          `Timezone: ${h.timezone} · auth ${h.auth.required ? "required" : "off"}`,
          ...(configError ? [`Config: the last edit was rejected, the previous config is still in use: ${configError}`] : []),
        ].join("\n"),
      ),
    );
  },

  help() {
    console.log(HELP);
  },
};

function fail(err) {
  const usage = err instanceof UsageError;
  if (opt?.json) console.error(JSON.stringify({ error: usage ? "usage" : (err.code ?? "error"), message: err.message, status: err.status }));
  else console.error(`error: ${err.message}${usage ? "\nRun `yaypost help` for usage." : ""}`);
  process.exit(usage ? 2 : 1);
}

const [cmd, ...args] = positionals;
if (!cmd || opt.help) {
  console.log(HELP);
  process.exit(cmd || opt.help ? 0 : 2);
}
if (!Object.hasOwn(commands, cmd)) fail(new UsageError(`Unknown command "${cmd}".`));
try {
  await commands[cmd](args);
} catch (err) {
  fail(err);
}
