// Telegram via the Bot API: a thread becomes consecutive messages in the chat, each replying to the previous one.
// Checked against https://core.telegram.org/bots/api (2026-10): POST /bot<token>/<method>; responses are
// { ok, result } or { ok:false, error_code, description, parameters?: { retry_after, migrate_to_chat_id } };
// getMe → User, getChat → ChatFullInfo (type, title, username), getChatMember → ChatMember; sendMessage text 1-4096,
// sendPhoto/sendAnimation caption 0-1024, sendMediaGroup 2-10 InputMediaPhoto (files via multipart "attach://<name>", returns
// Message[]); reply_parameters { message_id, allow_sending_without_reply }. No parse_mode: text is sent as typed.
// Telegram has no alt text for photos. TELEGRAM_API_BASE overrides https://api.telegram.org (tests, local Bot API).
import type { Credentials, PlatformDefinition, PublishItem, YaypostAPI } from "yaypost/plugin";

type PlatformError = InstanceType<YaypostAPI["PlatformError"]>;

/** verify/publish/metrics, bound to this plugin's `ts`. */
export function createTelegram(ts: YaypostAPI): Pick<PlatformDefinition, "verify" | "publish" | "metrics"> {
  interface TgResponse<T> {
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number; migrate_to_chat_id?: number };
  }
  interface TgChat {
    id: number;
    type: string;
    title?: string;
    username?: string;
  }
  interface TgMessage {
    message_id: number;
    chat: TgChat;
  }

  /** Flood-control waits up to this long are absorbed once; longer ones fail with "retry in …". */
  const MAX_WAIT_S = 15;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const apiBase = () => (ts.env("TELEGRAM_API_BASE") || "https://api.telegram.org").replace(/\/+$/, "");

  function explain(method: string, chatId: string, r: TgResponse<unknown>, status: number): PlatformError {
    const code = r.error_code ?? status;
    const detail = r.description ?? `HTTP ${status}`;
    if (code === 401 || code === 404) {
      return new ts.PlatformError(
        `Telegram rejected the bot token (${code}: ${detail}). Copy the token again from @BotFather (/mybots → API Token) and update the account.`,
        401,
      );
    }
    if (r.parameters?.migrate_to_chat_id) {
      return new ts.PlatformError(
        `The group ${chatId} was upgraded to a supergroup; change the chat id to ${r.parameters.migrate_to_chat_id} and Retry.`,
        400,
      );
    }
    if (code === 429) {
      return new ts.PlatformError(`Telegram flood control (${detail}). Retry in ${r.parameters?.retry_after ?? 60} s.`, 429);
    }
    if (code === 403 || /chat not found|not a member|kicked|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED/i.test(detail)) {
      return new ts.PlatformError(
        `The bot can't post in ${chatId} (${code}: ${detail}). Add the bot to the chat (as an admin with "Post messages" for a channel) and check the chat id (@channelname or the numeric -100… id), then Retry.`,
        403,
      );
    }
    if (code >= 500) return new ts.PlatformError(`Telegram error ${code} on ${method} (${detail}). Usually temporary: Retry in a few minutes.`, code);
    return new ts.PlatformError(`Telegram rejected ${method} (${code}: ${detail}).`, code);
  }

  async function call<T>(token: string, chatId: string, method: string, params: Record<string, unknown> | FormData): Promise<T> {
    const isForm = params instanceof FormData;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${apiBase()}/bot${token}/${method}`, {
          method: "POST",
          headers: isForm ? undefined : { "content-type": "application/json" },
          body: isForm ? params : JSON.stringify(params),
          signal: AbortSignal.timeout(isForm ? 90_000 : 30_000),
        });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") {
          throw new ts.PlatformError(`Telegram didn't answer ${method} in time; the message may or may not be posted, so check the chat before you Retry.`);
        }
        const cause = (err as { cause?: { code?: string } }).cause;
        throw new ts.PlatformError(`Couldn't reach Telegram at ${apiBase()} (${cause?.code ?? (err as Error).message}). Check the server's internet connection, then Retry.`);
      }
      let body: TgResponse<T>;
      try {
        body = (await res.json()) as TgResponse<T>;
      } catch {
        body = { ok: false, error_code: res.status, description: `HTTP ${res.status} with a non-JSON body` };
      }
      if (body.ok && body.result !== undefined) return body.result;
      const wait = body.parameters?.retry_after;
      if ((body.error_code ?? res.status) === 429 && attempt === 0 && wait !== undefined && wait <= MAX_WAIT_S) {
        await sleep(wait * 1000);
        continue;
      }
      throw explain(method, chatId, body, res.status);
    }
  }

  function photoBlob(id: string): { blob: Blob; filename: string } {
    const m = ts.media.get(id);
    if (!m) throw new ts.PlatformError(`An image of this post (${id}) no longer exists; remove it from the post and Retry.`, 400, true);
    return { blob: new Blob([new Uint8Array(ts.media.read(id))], { type: m.mime }), filename: m.filename };
  }

  /** Send one item; returns the message the next item should reply to (the first of an album). */
  async function sendItem(token: string, chatId: string, item: PublishItem, replyTo: number | null): Promise<TgMessage> {
    const reply = replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;
    if (!item.mediaIds.length) {
      return call<TgMessage>(token, chatId, "sendMessage", { chat_id: chatId, text: item.text, reply_parameters: reply });
    }
    const form = new FormData();
    form.set("chat_id", chatId);
    if (reply) form.set("reply_parameters", JSON.stringify(reply));
    if (item.mediaIds.length === 1) {
      const { blob, filename } = photoBlob(item.mediaIds[0]);
      const gif = blob.type === "image/gif"; // sendPhoto would flatten it; albums can't hold animations
      form.set(gif ? "animation" : "photo", blob, filename);
      if (item.text.trim()) form.set("caption", item.text);
      return call<TgMessage>(token, chatId, gif ? "sendAnimation" : "sendPhoto", form);
    }
    const media = item.mediaIds.map((id, i) => {
      const { blob, filename } = photoBlob(id);
      form.set(`photo${i}`, blob, filename);
      return { type: "photo", media: `attach://photo${i}`, ...(i === 0 && item.text.trim() ? { caption: item.text } : {}) };
    });
    form.set("media", JSON.stringify(media));
    const messages = await call<TgMessage[]>(token, chatId, "sendMediaGroup", form);
    if (!messages[0]) throw new ts.PlatformError("Telegram accepted the album but returned no messages; check the chat before you Retry.");
    return messages[0];
  }

  const publicUrl = (chat: TgChat | undefined, chatId: string, messageId: string) => {
    const username = chat?.username ?? (chatId.startsWith("@") ? chatId.slice(1) : null);
    return username ? `https://t.me/${username}/${messageId}` : null;
  };

  return {
    async verify(c: Credentials) {
      const token = c.botToken ?? "";
      const chatId = c.chatId ?? "";
      const bot = await call<{ id: number; username?: string }>(token, chatId, "getMe", {});
      const chat = await call<TgChat>(token, chatId, "getChat", { chat_id: chatId });
      const member = await call<{ status: string; can_post_messages?: boolean; can_send_messages?: boolean }>(
        token, chatId, "getChatMember", { chat_id: chatId, user_id: bot.id },
      );
      const where = chat.username ? `@${chat.username}` : (chat.title ?? String(chat.id));
      const cannot =
        member.status === "left" || member.status === "kicked"
          ? "isn't a member of"
          : chat.type === "channel" && !(member.status === "creator" || (member.status === "administrator" && member.can_post_messages !== false))
            ? `isn't an admin allowed to post messages in`
            : member.status === "restricted" && member.can_send_messages === false
              ? "is not allowed to send messages in"
              : null;
      if (cannot) {
        throw new ts.PlatformError(`The bot @${bot.username ?? bot.id} ${cannot} ${where}. Add it (channels: as an admin with "Post messages"), then connect again.`, 403);
      }
      return { handle: where, profileUrl: chat.username ? `https://t.me/${chat.username}` : null };
    },

    async publish(ctx) {
      const token = ctx.credentials.botToken ?? "";
      const chatId = ctx.credentials.chatId ?? "";
      const ids = [...ctx.posted];
      let chat: TgChat | undefined;
      for (const item of ctx.items.slice(ids.length)) {
        const last = ids.length ? Number(ids[ids.length - 1]) : null;
        const message = await sendItem(token, chatId, item, last);
        chat = message.chat;
        ids.push(String(message.message_id));
        ctx.record([...ids]);
      }
      return { ids, url: ids.length ? publicUrl(chat, chatId, ids[0]) : null };
    },
  };
}
