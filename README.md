# Yaypost

**Your AI agent does the social media work. You just say yay.**

An agent (Claude Code, Cursor, a scheduled routine, or Yaypost's built-in operator) writes, checks, schedules and
publishes posts to **X, Bluesky, Mastodon, Threads, LinkedIn, Telegram and Discord**, then reads the numbers and writes
the next one. Every post it wants to publish lands in your **Telegram or Discord** first. You tap **Approve**, reply
"shorter", or tap **Reject**. Nothing goes out without your yay.

Self-hosted: one Node process, one SQLite file, no accounts.

## Philosophy

1. **The agent is the brain. Yaypost is the hands and the guardrails.** No writing assistant, no "best time to post"
   guesses, no analytics dashboard. Agents do that better when they have the data. Yaypost gives them the data and
   safe actions, and nothing else.
2. **You decide, the server enforces it.** Approval is not a polite question in a chat window. An agent's post can't
   be published until a person approves it, whatever the agent tries. Agents can pull the emergency brake (`/pause`);
   only you can release it.
3. **Do the boring parts right.** Per-platform character counting, threads that resume after a failure without
   duplicates, retries that don't post twice, credentials the agent never sees.
4. **Stay small.** One process, one file of data, no queue servers. Every platform and every approval chat is a
   plugin; the core knows no platform by name.
5. **Show, don't explain.** The interface is for deciding fast on a phone: actions are obvious, details appear when you
   need them.

## Quick start

Needs Node.js ≥ 22.13 and pnpm.

```bash
pnpm install
pnpm build && pnpm start          # → http://127.0.0.1:3000   (or `pnpm dev` → http://localhost:5173)
```

Then:

1. **Connect an approval chat.** Create a bot with [@BotFather](https://t.me/BotFather), paste its token in
   *Settings → Plugins → telegram-approvals*, and tap **Open in Telegram** under *Inbox → Approval chats*.
2. **Connect your agent.**
   ```bash
   claude mcp add --transport http yaypost http://127.0.0.1:3000/mcp
   ```
3. **Give it a job:** "Every weekday, post a thread about the product to Bluesky and X, based on last week's numbers."

## How agents connect

| | |
|---|---|
| **MCP** | `/mcp` (Streamable HTTP) |
| **REST** | OpenAPI 3.1 at `/openapi.json`, interactive docs at `/docs` |
| **CLI** | `node cli/yaypost.mjs help` (`--json` everywhere) |
| **Skill** | `skill/yaypost/` teaches Claude the workflow |
| **llms.txt** | `/llms.txt`, `/llms-full.txt` |
| **Webhooks** | HMAC-signed (`X-Yaypost-Signature`), set up in Settings |

No agent of your own? Turn on the **operator** (*Inbox → Operator*): Claude runs on a schedule from your brief, using
the same tools and the same approval gate. Needs `ANTHROPIC_API_KEY` (or `ZAI_API_KEY`) in `.env`. It researches with
the read-only tools of remote MCP servers you list (web search through Parallel by default; add Firecrawl or any other).

## Running it for real

- **Docker:** `docker compose up -d --build`. Data lives in the `/data` volume.
- **Anywhere public:** set `AUTH_TOKEN` in `.env` and put HTTPS (e.g. Caddy) in front.
- **Back up** the `data/` folder. It holds the database, images and `secret.key`, which encrypts your credentials.
- **X** has no free API tier for new apps: connect X like any other account, with your app's API keys (pay per post).

All settings are in the app. `.env.example` lists the server options.

## Writing a plugin

A plugin is an npm package with a manifest in `package.json`. The built-in ones in `plugins/` use the same API as
yours. See [docs/PLUGINS.md](docs/PLUGINS.md) and the ~70-line example in `examples/plugin-webhook`.

## Status

Version 0.3. Every platform adapter is written against the official API docs and tested against mock servers, **not
yet against real accounts**. Try a short post on each platform first.

## License

[MIT](LICENSE)
