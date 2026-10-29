// Discord approval channel: a bot posts approval cards to one channel over REST and receives button presses over the
// Gateway (an outbound WebSocket), so it works on localhost with no public URL and needs no privileged intents.
// Buttons are message components; "Request changes" opens a modal asking for the note. Decisions are answered with
// an ephemeral reply; the hub edits the card itself through finalize(). Without the message-content intent a bot
// can't read text, so there are no text commands here.
// Reference: https://discord.com/developers/docs/reference (REST, rate limits), /events/gateway (HELLO, heartbeat,
// IDENTIFY, close codes), /interactions/receiving-and-responding (callbacks, modals), /components/reference.
// Settings (Plugins page; .env fallback): DISCORD_APPROVAL_BOT_TOKEN, DISCORD_APPROVAL_CHANNEL_ID, DISCORD_APPROVER_IDS (comma-separated Discord user ids
// allowed to decide; default: anyone who can see the channel).
// DISCORD_API_BASE overrides https://discord.com/api/v10 and DISCORD_GATEWAY_URL the gateway URL (tests).
import type { ChannelAction, ChannelButton, ChannelHandlers, YaypostAPI } from "yaypost/plugin";

interface DcUser {
  id: string;
  username?: string;
}
interface DcComponent {
  type: number;
  custom_id?: string;
  value?: string;
  components?: DcComponent[];
  component?: DcComponent;
}
interface DcInteraction {
  id: string;
  application_id: string;
  type: number; // 2 command, 3 component, 5 modal submit
  token: string;
  channel_id?: string;
  member?: { user?: DcUser };
  user?: DcUser;
  data?: { name?: string; custom_id?: string; components?: DcComponent[] };
}
interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

const DEFAULT_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CODES: Record<string, ChannelAction> = { a: "approve", r: "reject", c: "changes", p: "pause", u: "resume" };
const codeOf = (a: ChannelAction) => Object.entries(CODES).find(([, v]) => v === a)![0];
const STYLE: Partial<Record<ChannelAction, number>> = { approve: 3, reject: 4 }; // success, danger; others secondary (2)
const EPHEMERAL = 64;
/** Close codes after which reconnecting can't help (bad token, intents, shard or version). */
const FATAL_CLOSE: Record<number, string> = {
  4004: "Discord rejected the bot token (Plugins → discord-approvals) (gateway close 4004); copy the bot token again from the Developer Portal.",
  4010: "Discord gateway: invalid shard (4010).",
  4011: "Discord gateway: sharding required (4011); the bot is in too many servers for one connection.",
  4012: "Discord gateway: invalid API version (4012).",
  4013: "Discord gateway: invalid intents (4013).",
  4014: "Discord gateway: disallowed intents (4014); this bot needs no privileged intents, so check the gateway settings.",
};

class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Discord counts content in code points; never split a surrogate pair. */
const cut = (text: string, max = 2000) => {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max - 1).join("") + "…";
};

const components = (buttons?: ChannelButton[]) =>
  buttons?.length
    ? [
        {
          type: 1,
          components: buttons.slice(0, 5).map((b) => ({
            type: 2,
            style: STYLE[b.action] ?? 2,
            label: cut(b.label, 80),
            custom_id: `${codeOf(b.action)}:${b.postId ?? ""}`,
          })),
        },
      ]
    : [];

const userOf = (i: DcInteraction) => i.member?.user ?? i.user;
const who = (i: DcInteraction) => `discord:${userOf(i)?.username ?? userOf(i)?.id ?? "unknown"}`;

/** The modal's "note" field; modals nest inputs in action rows (type 1) or labels (type 18). */
function noteOf(list: DcComponent[] = []): string | undefined {
  for (const c of list) {
    if (c.custom_id === "note" && typeof c.value === "string") return c.value;
    const found = noteOf([...(c.components ?? []), ...(c.component ? [c.component] : [])]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export default function discordApprovals(ts: YaypostAPI): void {
  // Settings from the Plugins page (or DISCORD_APPROVAL_* in .env), read on use so a saved change applies at once.
  const setting = (key: string) => (typeof ts.settings()[key] === "string" ? (ts.settings()[key] as string).trim() || undefined : undefined);
  const botToken = () => setting("botToken");
  // A pasted channel link (discord.com/channels/<server>/<channel>) works too: keep only the channel id.
  const channelId = () => {
    const raw = setting("channelId");
    return raw?.match(/discord(?:app)?\.com\/channels\/[^/]+\/(\d+)/)?.[1] ?? raw;
  };
  /** A bot token starts with the bot's user id in base64; pasting that id as the channel id is a common mistake. */
  const botId = () => {
    const head = botToken()?.split(".")[0];
    if (!head) return undefined;
    const id = Buffer.from(head.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return /^\d+$/.test(id) ? id : undefined;
  };
  const channelIsBot = () => Boolean(channelId() && channelId() === botId());
  const HOW = "Type /channel-id in the channel you want approvals in: the bot replies with its id. Put that in Plugins → discord-approvals → Channel id.";
  const CHANNEL_IS_BOT = `Channel id is the bot's own id, not a channel. ${HOW}`;
  const NO_CHANNEL = `No channel yet. ${HOW}`;
  const NOT_CHANNEL = `That isn't a channel id or channel link (a server link has no channel in it). ${HOW}`;
  /** Why sending can't work with the current settings, known without asking Discord. */
  const setupProblem = () => {
    const id = channelId();
    return !id ? NO_CHANNEL : !/^\d+$/.test(id) ? NOT_CHANNEL : channelIsBot() ? CHANNEL_IS_BOT : null;
  };
  const approverIds = () => (setting("approverIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const apiBase = () => (ts.env("DISCORD_API_BASE") || "https://discord.com/api/v10").replace(/\/+$/, "");

  let connected = false;
  let lastError: string | null = null;
  /** The last failed send, kept apart from gateway errors; cleared by the next send that works. */
  let sendError: string | null = null;
  let running = false;
  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  /** Discord asked us to reconnect (op 7): routine, so reconnect at once without logging an error. */
  let asked = false;

  /** One REST call. Retries once on 429 if Discord asks to wait ≤ 15 s; maps common failures to plain advice. */
  async function rest<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${apiBase()}${path}`, {
        method,
        headers: {
          ...(auth ? { authorization: `Bot ${botToken()}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "user-agent": "DiscordBot (https://github.com/yaypost, 1.0)",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 204) return undefined as T;
      const data = (await res.json().catch(() => ({}))) as { code?: number; message?: string; retry_after?: number } & T;
      if (res.ok) return data;
      if (res.status === 429 && attempt === 0 && (data.retry_after ?? Infinity) <= 15) {
        await sleep(Math.ceil((data.retry_after ?? 1) * 1000));
        continue;
      }
      if (res.status === 401) throw new RestError("Discord rejected the bot token (Plugins → discord-approvals); copy the bot token again from the Developer Portal.", 401);
      if (data.code === 50001 || data.code === 50013 || res.status === 403)
        throw new RestError(
          `Discord ${method} ${path.split("/")[1]}: ${data.message ?? "Forbidden"}. Invite the bot to the server and give it View Channel + Send Messages in that channel.`,
          res.status,
        );
      if (data.code === 10003) throw new RestError(channelIsBot() ? CHANNEL_IS_BOT : `Discord: no channel with that id (it may be a server or user id). ${HOW}`, res.status);
      throw new RestError(`Discord ${method} ${path.split("/")[1]}: ${data.message ?? `HTTP ${res.status}`}${res.status === 429 ? " (rate limited)" : ""}`, res.status);
    }
  }

  /** Only the configured channel, and (if listed) only the listed people, can decide. */
  const allowed = (i: DcInteraction) => {
    const ids = approverIds();
    return i.channel_id === channelId() && (!ids.length || ids.includes(userOf(i)?.id ?? ""));
  };

  const callback = (i: DcInteraction, body: unknown) => rest(`POST`, `/interactions/${i.id}/${i.token}/callback`, body, false);
  const ephemeral = (i: DcInteraction, text: string) => callback(i, { type: 4, data: { content: cut(text), flags: EPHEMERAL, allowed_mentions: { parse: [] } } });

  /**
   * Run a decision and answer it. act() is quick DB work, but Discord drops a callback after 3 s, so if it hasn't
   * finished in 2 s the interaction is deferred (type 5) and the answer edits that deferred reply via the webhook.
   */
  async function answerWith(i: DcInteraction, work: Promise<string>): Promise<void> {
    const result = work.catch((err: Error) => `⚠ ${err.message}`);
    const quick = await Promise.race([result, sleep(2_000).then(() => null)]);
    if (quick !== null) return void (await ephemeral(i, quick));
    await callback(i, { type: 5, data: { flags: EPHEMERAL } });
    await rest("PATCH", `/webhooks/${i.application_id}/${i.token}/messages/@original`, { content: cut(await result), allowed_mentions: { parse: [] } }, false);
  }

  async function handleInteraction(i: DcInteraction, h: ChannelHandlers): Promise<void> {
    // /channel-id: the way to find the id to configure; works in any channel the bot can see.
    if (i.type === 2 && i.data?.name === "channel-id")
      return void (await ephemeral(
        i,
        i.channel_id === channelId()
          ? `Approvals already go to this channel (${i.channel_id}).`
          : `This channel's id is ${i.channel_id}. Put it in Yaypost → Plugins → discord-approvals → Channel id.`,
      ));
    if (i.type !== 3 && i.type !== 5) return void (await ephemeral(i, "Use the buttons on approval requests."));
    if (!allowed(i)) return void (await ephemeral(i, "You can't decide here."));
    const [code, postId = ""] = (i.data?.custom_id ?? "").split(":");
    if (i.type === 5) {
      if (code !== "m" || !postId) return;
      return answerWith(i, h.act(who(i), "changes", postId, noteOf(i.data?.components)?.trim() || undefined));
    }
    const action = CODES[code ?? ""];
    if (!action) return;
    if (action === "changes") {
      return void (await callback(i, {
        type: 9,
        data: {
          custom_id: `m:${postId}`,
          title: "Request changes",
          components: [
            {
              type: 1,
              components: [
                { type: 4, custom_id: "note", label: "What should change?", style: 2, required: true, max_length: 4000, placeholder: "e.g. shorter, no hashtags, mention the launch date" },
              ],
            },
          ],
        },
      }));
    }
    return answerWith(i, h.act(who(i), action, postId || null));
  }

  // ---------- gateway ----------

  function clearHeartbeat(): void {
    if (heartbeat) clearTimeout(heartbeat);
    heartbeat = null;
  }

  /**
   * One gateway session: connect, IDENTIFY on HELLO, heartbeat, dispatch interactions. Resolves when the socket closes,
   * with the close code. No RESUME: every reconnect identifies afresh (missed button presses simply fail for the user).
   */
  function session(url: string, h: ChannelHandlers): Promise<number> {
    return new Promise((resolve) => {
      const sock = new WebSocket(url);
      ws = sock;
      let seq: number | null = null;
      let acked = true;
      const send = (p: GatewayPayload) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(p));
      const beat = () => {
        if (!acked) return sock.close(4000, "heartbeat ACK missed"); // zombie connection
        acked = false;
        send({ op: 1, d: seq });
      };
      sock.onmessage = (ev) => {
        let p: GatewayPayload;
        try {
          p = JSON.parse(String(ev.data)) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof p.s === "number") seq = p.s;
        switch (p.op) {
          case 10: {
            const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
            clearHeartbeat();
            const loop = () => {
              beat();
              heartbeat = setTimeout(loop, interval);
            };
            heartbeat = setTimeout(loop, interval * Math.random()); // jitter the first beat
            send({ op: 2, d: { token: botToken(), intents: 0, properties: { os: process.platform, browser: "yaypost", device: "yaypost" } } });
            break;
          }
          case 11:
            acked = true;
            break;
          case 1:
            send({ op: 1, d: seq });
            break;
          case 7: // RECONNECT
            asked = true;
            sock.close(4000, "reconnect requested");
            break;
          case 9: // INVALID_SESSION (we never RESUME, so just identify again on a new connection)
            sock.close(4000, "invalid session");
            break;
          case 0:
            if (p.t === "READY") {
              connected = true;
              lastError = null;
              // Create (or update, by name) the /channel-id command once per app: READY comes on every reconnect,
              // and Discord allows 200 command creates a day. Other commands of this app are left alone.
              const app = (p.d as { application?: { id?: string } }).application?.id;
              if (app && ts.store.get<string>("commandsFor") !== app)
                void rest("POST", `/applications/${app}/commands`, {
                  name: "channel-id",
                  description: "Show this channel's id, to send Yaypost approvals here",
                  type: 1,
                })
                  .then(() => ts.store.set("commandsFor", app))
                  .catch((err) => ts.log.warn(`register /channel-id: ${(err as Error).message}`));
            } else if (p.t === "INTERACTION_CREATE") {
              void handleInteraction(p.d as DcInteraction, h).catch((err) => {
                lastError = (err as Error).message;
                ts.log.warn(`interaction: ${lastError}`);
              });
            }
            break;
        }
      };
      sock.onerror = () => undefined; // onclose follows with the code
      sock.onclose = (ev) => {
        clearHeartbeat();
        connected = false;
        if (ws === sock) ws = null;
        resolve(ev.code);
      };
    });
  }

  async function gatewayUrl(): Promise<string> {
    const override = ts.env("DISCORD_GATEWAY_URL");
    if (override) return override;
    const { url } = await rest<{ url?: string }>("GET", "/gateway/bot"); // also checks the token
    return url ? `${url.replace(/\/+$/, "")}/?v=10&encoding=json` : DEFAULT_GATEWAY;
  }

  async function run(h: ChannelHandlers): Promise<void> {
    let backoff = 2_000;
    while (running) {
      const started = Date.now();
      asked = false;
      try {
        const url = await gatewayUrl();
        if (!running) return;
        const code = await session(url, h);
        if (!running) return;
        if (FATAL_CLOSE[code]) {
          lastError = FATAL_CLOSE[code];
          ts.log.warn(`${lastError} Not reconnecting.`);
          running = false;
          return;
        }
        if (asked) continue;
        if (Date.now() - started > 60_000) backoff = 2_000; // a long healthy session resets the backoff
        lastError = `Discord gateway closed (${code}).`;
      } catch (err) {
        if (!running) return;
        lastError = (err as Error).message;
        if (err instanceof RestError && err.status === 401) {
          ts.log.warn(`${lastError} Not reconnecting.`);
          running = false;
          return;
        }
      }
      ts.log.warn(`${lastError} (reconnecting in ${backoff / 1000} s)`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, backoff);
        wake = () => (clearTimeout(t), r());
      });
      wake = null;
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  ts.registerChannel({
    id: "discord",
    name: "Discord",
    maxLength: 2000,
    // The token alone connects the bot, so /channel-id exists before a channel is set.
    configured: () => Boolean(botToken()),
    status: () => ({ connected, error: setupProblem() ?? sendError ?? lastError }),
    start(h) {
      if (running) return;
      running = true;
      lastError = null;
      void run(h);
    },
    stop() {
      running = false;
      connected = false;
      clearHeartbeat();
      ws?.close(1000, "stopping");
      wake?.();
    },
    async send(message) {
      // Known to fail: no call, and the status already says why.
      if (setupProblem()) return null;
      const channel = channelId();
      try {
        const sent = await rest<{ id: string }>("POST", `/channels/${channel}/messages`, {
          content: cut(message.text),
          allowed_mentions: { parse: [] },
          components: components(message.buttons),
        });
        sendError = null;
        return `${channel}:${sent.id}`;
      } catch (err) {
        const msg = (err as Error).message;
        // Every pending approval is re-sent on start: log a failure once, not once per post.
        if (msg !== sendError) ts.log.warn(`send: ${msg}`);
        sendError = msg;
        return null;
      }
    },
    async finalize(ref, text) {
      const [refChannel, messageId] = ref.split(":");
      try {
        await rest("PATCH", `/channels/${refChannel}/messages/${messageId}`, { content: cut(text), allowed_mentions: { parse: [] }, components: [] });
      } catch (err) {
        ts.log.warn(`finalize: ${(err as Error).message}`);
      }
    },
  });
}
