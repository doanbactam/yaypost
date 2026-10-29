// Telegram approval chat via the Bot API with long polling (getUpdates), so it works on localhost with no public URL.
// Approval cards carry inline buttons (callback_query); "Request changes" asks for the note with a ForceReply prompt,
// and a plain reply to a card works too. Commands: /pending /status /pause [reason] /resume.
// Bot API reference: https://core.telegram.org/bots/api (getUpdates, sendMessage, editMessageText, answerCallbackQuery).
// Settings (Plugins page; .env fallback): TELEGRAM_APPROVAL_BOT_TOKEN (from @BotFather), TELEGRAM_APPROVAL_CHAT_ID (your private chat with the bot, or a
// group), TELEGRAM_APPROVER_IDS (comma-separated Telegram user ids allowed to decide; default: anyone in that chat).
// TELEGRAM_API_BASE overrides https://api.telegram.org (tests, local Bot API server).
import type { ChannelAction, ChannelButton, ChannelCommand, ChannelHandlers, YaypostAPI } from "yaypost/plugin";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; username?: string; type?: string };
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CODES: Record<string, ChannelAction> = { a: "approve", r: "reject", c: "changes", p: "pause", u: "resume" };
const codeOf = (a: ChannelAction) => Object.entries(CODES).find(([, v]) => v === a)![0];
const COMMANDS: ChannelCommand[] = ["pending", "status", "pause", "resume"];

const refOf = (m: { chat: { id: number }; message_id: number }) => `${m.chat.id}:${m.message_id}`;
const who = (u?: TgUser) => `telegram:${u?.username ? `@${u.username}` : (u?.id ?? "unknown")}`;

const keyboard = (buttons?: ChannelButton[]) =>
  buttons?.length ? { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: `${codeOf(b.action)}:${b.postId ?? ""}` }))] } : undefined;

export default function telegramApprovals(ts: YaypostAPI): void {
  // Settings from the Plugins page (or TELEGRAM_APPROVAL_* in .env), read on use so a saved change applies at once.
  const setting = (key: string) => (typeof ts.settings()[key] === "string" ? (ts.settings()[key] as string).trim() || undefined : undefined);
  const botToken = () => setting("botToken");
  const approverIds = () => (setting("approverIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  /** The bot's own id is the number before ":" in its token; a common mistake is to paste it as the chat id. */
  const botId = () => botToken()?.split(":")[0];
  /**
   * A chat connected through the secret /start link. It replaces the Chat id setting that was there when it was made
   * (empty or wrong); editing the setting afterwards takes precedence again.
   */
  type Link = { chat: string; replaced: string | null };
  const linked = () => ts.store.get<Link>(`chat:${botId()}`);
  const chatId = () => {
    const set = setting("chatId");
    const l = linked();
    return l && (set ?? null) === l.replaced ? l.chat : (set ?? l?.chat);
  };
  const chatIsBot = () => Boolean(chatId() && chatId() === botId());
  /** Secret for the connect link, per bot, so only someone who sees Yaypost can claim the chat. */
  const linkCode = () => {
    const key = `code:${botId()}`;
    let code = ts.store.get<string>(key);
    if (!code) ts.store.set(key, (code = crypto.randomUUID().replaceAll("-", "").slice(0, 16)));
    return code;
  };
  let username: string | null = null;
  const connectHint = () =>
    username ? `Connect: https://t.me/${username}?start=${linkCode()}` : `Connect: send "/start ${linkCode()}" to the bot in Telegram.`;
  const CHAT_IS_BOT = () => `Chat id is the bot's own id, not yours. ${connectHint()}`;
  const NO_CHAT = () => `No chat yet. ${connectHint()}`;
  const OTHER_BOT = () => `Chat id belongs to another bot. ${connectHint()}`;
  /** Updates are confirmed per bot: a new token must not inherit the old bot's offset. */
  const offsetKey = () => `offset:${botId()}`;
  const apiBase = () => (ts.env("TELEGRAM_API_BASE") || "https://api.telegram.org").replace(/\/+$/, "");

  let connected = false;
  let lastError: string | null = null;
  /** The last failed send, kept apart from polling errors so a healthy poll doesn't hide it. */
  let sendError: string | null = null;
  /** Telegram said the chat id is a bot: the chat isn't usable, so /start answers anyone until it is fixed. */
  let otherBot = false;
  /** Waiting for a chat id: /start tells whoever writes which id to use. */
  const settingUp = () => !chatId() || chatIsBot() || otherBot;
  let abort: AbortController | null = null;
  /** ForceReply prompts ("what should change?") → the post they are about. */
  const prompts = new Map<string, string>();

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${apiBase()}/bot${botToken()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!data.ok) {
      const code = data.error_code ?? res.status;
      if (code === 401 || code === 404) throw new Error("Telegram rejected the bot token (Plugins → telegram-approvals); copy it again from @BotFather.");
      if (code === 409) throw new Error("Another program reads this bot's updates (a webhook or a second Yaypost). Use a bot only for approvals.");
      if (code === 403 && /bot can.t send messages to (the )?bots?/i.test(data.description ?? ""))
        throw new Error(chatIsBot() ? CHAT_IS_BOT() : ((otherBot = true), OTHER_BOT()));
      throw new Error(`Telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`);
    }
    return data.result as T;
  }

  /** Only the configured chat, and (if listed) only the listed people, can decide. */
  function allowed(chat: { id: number; username?: string }, from?: TgUser): boolean {
    const target = chatId() ?? "";
    const sameChat = String(chat.id) === target || (chat.username && `@${chat.username}`.toLowerCase() === target.toLowerCase());
    if (!sameChat) return false;
    const ids = approverIds();
    return !ids.length || (from !== undefined && ids.includes(String(from.id)));
  }

  async function reply(to: number | string, text: string, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return call<TgMessage>("sendMessage", { chat_id: to, text: text.slice(0, 4096), link_preview_options: { is_disabled: true }, ...extra });
  }

  async function handle(update: TgUpdate, h: ChannelHandlers): Promise<void> {
    const cb = update.callback_query;
    if (cb) {
      if (!cb.message || !allowed(cb.message.chat, cb.from)) {
        await call("answerCallbackQuery", { callback_query_id: cb.id, text: "You can't decide here." });
        return;
      }
      const [code, postId] = (cb.data ?? "").split(":");
      const action = CODES[code ?? ""];
      if (!action) return;
      if (action === "changes") {
        await call("answerCallbackQuery", { callback_query_id: cb.id });
        const prompt = await reply(cb.message.chat.id, "✏️ What should change? Reply to this message; the agent gets your words as they are.", {
          reply_markup: { force_reply: true, input_field_placeholder: "e.g. shorter, no hashtags, mention the launch date" },
          reply_parameters: { message_id: cb.message.message_id, allow_sending_without_reply: true },
        });
        prompts.set(refOf(prompt), postId!);
        return;
      }
      const text = await h.act(who(cb.from), action, postId || null).catch((err: Error) => `⚠ ${err.message}`);
      await call("answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 200) });
      return;
    }
    const msg = update.message;
    if (!msg?.text) return;
    // The secret connect link (t.me/<bot>?start=<code>) arrives as "/start <code>": that chat becomes the approval chat.
    if (msg.text.trim() === `/start ${linkCode()}`) {
      const ids = approverIds();
      if (ids.length && !(msg.from && ids.includes(String(msg.from.id)))) {
        await reply(msg.chat.id, "You aren't in this bot's list of people who may decide.");
        return;
      }
      ts.store.set(`chat:${botId()}`, { chat: String(msg.chat.id), replaced: setting("chatId") ?? null } satisfies Link);
      otherBot = false;
      sendError = null;
      ts.log.info(`connected to chat ${msg.chat.id}`);
      const pending = await h.command(who(msg.from), "pending").catch(() => "");
      await reply(msg.chat.id, `✅ Connected. Approval requests arrive here.${pending ? `\n\n${pending}` : ""}`);
      return;
    }
    // Not set up yet (or set to a bot's id): tell whoever writes to the bot privately, or runs a command in a group, which chat id to use.
    if (!allowed(msg.chat, msg.from)) {
      if (settingUp() && (msg.chat.type === "private" || msg.text.startsWith("/")))
        await reply(msg.chat.id, `Your chat id is ${msg.chat.id}. Put it in Yaypost → Plugins → telegram-approvals → Chat id.`);
      return;
    }
    if (msg.reply_to_message) {
      const ref = `${msg.chat.id}:${msg.reply_to_message.message_id}`;
      const postId = prompts.get(ref) ?? h.postForRef(ref);
      if (postId && !msg.text.startsWith("/")) {
        prompts.delete(ref);
        const text = await h.act(who(msg.from), "changes", postId, msg.text).catch((err: Error) => `⚠ ${err.message}`);
        await reply(msg.chat.id, text, { reply_parameters: { message_id: msg.message_id } });
        return;
      }
    }
    const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(msg.text.trim());
    if (!m) return;
    const name = m[1]!.toLowerCase();
    const command = COMMANDS.find((c) => c === name);
    const text = command
      ? await h.command(who(msg.from), command, m[2]).catch((err: Error) => `⚠ ${err.message}`)
      : "Commands: /pending (what waits for you), /status (digest now), /pause [reason], /resume.\n" +
        "Approval requests arrive here with buttons; to ask for changes, press ✏️ or reply to the request.";
    await reply(msg.chat.id, text);
  }

  async function poll(h: ChannelHandlers, signal: AbortSignal): Promise<void> {
    let backoff = 2_000;
    let offset = ts.store.get<number>(offsetKey()) ?? 0;
    while (!signal.aborted) {
      try {
        const updates = await call<TgUpdate[]>(
          "getUpdates",
          { offset, timeout: 50, allowed_updates: ["message", "callback_query"] },
          AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
        );
        connected = true;
        lastError = null;
        backoff = 2_000;
        for (const u of updates) {
          offset = u.update_id + 1;
          ts.store.set(offsetKey(), offset); // before handling: a crash mid-update must not replay a decision
          await handle(u, h).catch((err) => ts.log.warn(`update ${u.update_id}: ${(err as Error).message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        connected = false;
        lastError = (err as Error).message;
        ts.log.warn(`${lastError} (retrying in ${backoff / 1000} s)`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  ts.registerChannel({
    id: "telegram",
    name: "Telegram",
    maxLength: 4096,
    // The token alone starts the bot, so /start can hand out the chat id before one is set.
    configured: () => Boolean(botToken()),
    status: () => ({ connected, error: !chatId() ? NO_CHAT() : chatIsBot() ? CHAT_IS_BOT() : otherBot ? OTHER_BOT() : (sendError ?? lastError) }),
    commandsHint: "Commands: /pending /status /pause /resume",
    start(h) {
      abort?.abort();
      abort = new AbortController();
      void call<TgUser>("getMe", {})
        .then((me) => (username = me.username ?? null))
        .catch(() => undefined);
      void call("setMyCommands", {
        commands: [
          { command: "pending", description: "What is waiting for you" },
          { command: "status", description: "Digest now" },
          { command: "pause", description: "Stop all publishing" },
          { command: "resume", description: "Restart publishing" },
        ],
      }).catch(() => undefined);
      void poll(h, abort.signal);
    },
    stop() {
      abort?.abort();
      connected = false;
    },
    async send(message) {
      // Known to fail: no call, and the status already says why.
      if (!chatId() || chatIsBot()) return null;
      try {
        const sent = await reply(chatId()!, message.text, { reply_markup: keyboard(message.buttons) });
        sendError = null;
        otherBot = false;
        return refOf(sent);
      } catch (err) {
        const msg = (err as Error).message;
        // Every pending approval is re-sent on start: log a failure once, not once per post.
        if (msg !== sendError) ts.log.warn(`send: ${msg}`);
        sendError = msg;
        return null;
      }
    },
    async finalize(ref, text) {
      const [refChat, messageId] = ref.split(":");
      try {
        await call("editMessageText", { chat_id: refChat, message_id: Number(messageId), text: text.slice(0, 4096), link_preview_options: { is_disabled: true } });
      } catch (err) {
        ts.log.warn(`finalize: ${(err as Error).message}`);
      }
    },
  });
}
