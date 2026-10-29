---
name: yaypost
description: Run the user's social publishing end to end through their self-hosted Yaypost server - draft, check and queue posts and threads for X (Twitter), Bluesky, Mastodon, Threads, LinkedIn, Telegram and Discord (the user approves from Yaypost or their Telegram/Discord chat), act on their feedback, read how published posts perform, and continue threads. Use when the user wants to write a post or thread, cross-post it to several platforms (with per-platform versions), turn notes or an article into a thread, queue something for a time or the next free slot, see what's scheduled, edit, reschedule or delete queued posts, get a thread ready to post by hand, or check how published posts performed and follow up on them.
---

# Yaypost

Yaypost is the user's publishing layer for you, the agent: you do the work end to end, it handles credentials,
per-platform counting, resumable publishing, scheduling and engagement data, and the user only decides. By default
nothing you queue is published until they approve it: they get the exact preview in the web UI and in their
Telegram/Discord chat and press Approve, Request changes or Reject. It stores drafts and threads, counts characters the way each
platform does, queues posts into posting slots, and publishes them to the user's connected accounts on X, Bluesky,
Mastodon, Threads, LinkedIn, Telegram and Discord. A post needs at least one destination before it can be scheduled
or published; without one it stays a draft.

## Reaching it

Prefer, in this order:

1. **MCP tools**, if a `yaypost` MCP server is connected (tools such as `get_settings`, `count_characters`,
   `create_post`, `list_queue`). They return structured results. To connect Claude Code:
   `claude mcp add --transport http yaypost http://127.0.0.1:3000/mcp`
   (add `--header "Authorization: Bearer <token>"` when the server has a token; agents get AGENT_TOKEN if it is set).
2. **The CLI**: `yaypost <command>` if it's on PATH, otherwise `node <yaypost-repo>/cli/yaypost.mjs <command>`.
   It reads `YAYPOST_URL` (default `http://127.0.0.1:3000`) and `YAYPOST_TOKEN` (the server's AUTH_TOKEN).
   Add `--json` for machine-readable output. Exit codes: 0 ok, 1 API or network error (also when `publish` or
   `retry` ends with the post `failed`), 2 usage error.
3. **REST**, with `Authorization: Bearer $YAYPOST_TOKEN` when auth is on.
   Every POST under `/api` accepts `Idempotency-Key`: a repeat with the same key on the same path replays the first
   successful answer instead of acting twice. `GET $YAYPOST_URL/llms-full.txt` documents every route;
   `/openapi.json` is the full spec.

Start with `yaypost health --json` and `yaypost accounts --json` (or `get_settings`, which has both) to learn
the connected accounts and their per-post limits, the timezone, the approval policy and whether publishing is paused. Then `yaypost reviews` / `list_reviews`: posts the user
sent back with feedback come first. If the server isn't reachable, tell the
user how to start it (`pnpm start` or `pnpm dev` in the Yaypost folder) rather than guessing.

## Workflow

1. **Understand the ask.** Topic, audience, any facts, numbers or links that must appear, where it should go
   (which connected accounts) and when. Ask for missing facts instead of inventing them; decide everything else yourself.
2. **Draft** in the user's voice and language. `get_settings` returns `voiceExamples` (their past posts): match
   their tone, sentence length and formatting. `yaypost feedback` / `get_feedback` returns what they said when sending back,
   rejecting or approving earlier posts: follow those notes in every new draft. Write the thread as one text with a line containing only `---`
   between posts.
3. **Check counts for every destination** before saving: `yaypost count --platform bluesky --file draft.txt` or
   `count_characters` with `platform`. Shorten every post that is over; a post over a destination's limit is saved but
   that destination fails when publishing. If one text can't suit every platform, write a version for the odd one out
   (typically a tighter X thread, or one long LinkedIn post).
4. **Queue it; the approval is the ask.** With approval on (`get_settings` → `approval.require: "agents"`, the default),
   schedule finished, checked posts (`--at next` or a time) with a clear `--title`: the user decides from their chat, so
   don't ask "shall I schedule?" first. With approval off, show them the thread and ask before scheduling or publishing.
   Never delete without their go-ahead.
5. **Save**: `yaypost new --file draft.txt --to bluesky,mastodon --version x=x.txt --at next --json` (or
   `create_post` with `to`, `versions` and `schedule: "next"`), then `yaypost preview <id>` / `preview_post` and
   fix every `problem`.
   An exact time is ISO-8601 with an offset, e.g. `2026-11-03T09:00:00+07:00`. Without an offset
   (`2026-11-03T09:00`) the server reads it in its configured `timezone`; a date alone or a past time is refused.
6. **Report**: what you queued, for when, and that it waits for their approval. When they request changes
   (`approval.state: "changes_requested"`, `approval.note`), revise with `edit` / `update_post`; that asks them again.
   Report the scheduled time in the user's timezone. The CLI prints times in the
   server's timezone and names it (`--json` gives UTC); convert if the user lives elsewhere. `yaypost queue`
   shows the timeline and the remaining free slots.

Common follow-ups:

| Goal | CLI | MCP tool |
|---|---|---|
| What's scheduled? | `yaypost queue --days 7` | `list_queue` |
| Open slots | `yaypost slots 5` | `next_free_slots` |
| Read a post (with each destination's status) | `yaypost show <id>` | `get_post` |
| What each platform will get | `yaypost preview <id>` | `preview_post` |
| Where can it go? | `yaypost accounts`, `yaypost platforms` | `list_accounts`, `list_platforms` |
| Change destinations / versions | `yaypost edit <id> --to bluesky,linkedin --version linkedin=li.txt` | `update_post` with `to` / `versions` |
| Edit main text (images stay put) | `yaypost edit <id> --file new.txt` (`--title t` alone only renames) | `update_post` |
| Reschedule / unqueue | `yaypost schedule <id> next` / `unschedule <id>` | `schedule_post` / `unschedule_post` |
| Post by hand | `yaypost copy <id> --clipboard`, then `posted <id> --url <link>` | `export_thread`, `mark_published` |
| Failed or due post | `yaypost show <id>` (read `error`), fix, `retry <id>` | `get_post`, `retry_post` |
| Waiting on the user / sent back | `yaypost reviews` | `list_reviews` |
| What they said about past posts | `yaypost feedback` | `get_feedback` |
| Something went wrong: stop everything | `yaypost pause "why"` (only the user resumes) | `pause_publishing` |
| Add an image | `yaypost new ... --image 2:chart.png` | `attach_image_from_url` |

Ids can be shortened to a unique prefix in the CLI. Piping works: `cat draft.txt | yaypost new --file - --at next`.

## Destinations, versions and platforms

- **Destinations** are connected accounts. Refer to one by id (or a unique prefix in the CLI), label, handle, or
  platform name when exactly one account of that platform is connected; ambiguous references are refused with the
  choices. Connecting an account needs the user's secrets, so they do it in the web UI; never ask them to paste tokens.
- **Versions**: each destination publishes the main thread unless it has its own version. Images carry over by position.
- **Each destination publishes and resumes on its own.** A post is `published` when all are; `failed` when any is
  (see each destination's error). `retry` only redoes the ones that didn't go out.
- **How a thread lands**: X, Bluesky, Mastodon and Threads post a reply chain; LinkedIn joins the posts into ONE post
  (blank lines between); Telegram and Discord send consecutive messages.

| Platform | Limit per post | Counting | Images per post | Cost |
|---|---|---|---|---|
| X | 280 (Premium: set on the account) | weighted: CJK, emoji, Vietnamese ạ ệ ố… 2; URLs 23 | 4 | Paid API: ~$0.015/post, ~$0.20 with a link |
| Bluesky | 300 | graphemes; URLs count in full | 4 | Free |
| Mastodon | 500 (instance may differ) | code points; URLs 23 | 4 | Free |
| Threads | 500 | code points; each emoji = its UTF-8 bytes (usually 4) | 20 (JPEG/PNG) | Free (Meta app needed) |
| LinkedIn | 3000, one post | code points | 20 (JPEG/PNG/GIF) | Free |
| Telegram | 4096 (1024 caption with a photo) | code points | 10 | Free |
| Discord | 2000 | code points | 10 | Free |

The same Vietnamese post can fit Bluesky (graphemes) and be over on X (weighted), so always check each destination.
An account can override its limit (`maxChars`); `yaypost platforms` / `list_platforms` is authoritative.

Platform habits worth following: Mastodon discovery runs on hashtags (one to three CamelCase tags help); Threads allows
one topic tag; LinkedIn shows only ~210 characters before "see more", so the opening line carries it; Bluesky links
count in full, so prefer short links.

## Things Yaypost deliberately leaves to you (the agent)

Yaypost provides data and actions; judgment is yours. There is no analytics dashboard, best-time engine,
auto-plug rule or evergreen recycler, because you do these better with the data:

- **What works**: `list_metrics` (CLI `yaypost metrics --json`) → refresh the ones you care about with
  `get_metrics {refresh: true}` → compare by topic, format, length, time of day, platform. Report patterns with
  numbers, not vibes; say how many posts the conclusion rests on.
- **When to post**: derive good hours per platform from the same data, then propose slot changes for
  `yaypost.config.json` to the person (you can't edit it through the API; that is intentional).
- **Plug / follow-up**: when a published thread is clearly outperforming (relative to that account's own history),
  draft a follow-up and `append_to_post` (CLI `yaypost append <id>`): it replies to the
  last live post on every destination that threads. Remember a link costs $0.20 per post on X's API.
- **Evergreen**: find old top performers, rewrite rather than repeat verbatim (platforms penalise duplicates), and
  queue them as new posts with `create_post` (or `POST /api/posts/{id}/duplicate`, then edit).
- **Running it on a schedule**: a scheduled agent (a Claude Code routine, Claude Duet, cron + the CLI, or Yaypost's
  own operator) runs the above; the approval gate keeps the person in charge. X metric reads are billed: only with their OK (`paid`).

## Writing threads that work

- **The first post carries the thread.** Most people only see it in their timeline. Lead with the most concrete,
  surprising or useful thing (a result, a number, a strong claim, a moment) and make it stand on its own.
  Skip "A thread 🧵", "1/", and "Here's what I learned" unless the user writes that way.
- **One idea per post.** Each post should still make sense if someone lands on it from a quote or reply.
- **Specific beats general.** Names, numbers, examples and before/after comparisons beat adjectives. Cut hedges,
  throat-clearing and filler.
- **Short is a feature.** Often one strong post beats a thread; 3 to 8 posts covers most threads. Stop when the
  material runs out.
- **End by landing the point.** State the takeaway; add a call to action only when there's something real to do.
- **Plain text.** X, Bluesky, Mastodon, Threads and LinkedIn don't render Markdown. Use line breaks for rhythm. Hashtags rarely help; use them only if the
  user does.
- **Links:** posts with external links tend to get less reach and cost more to publish through the API. Leave links
  out unless the user wants one, and then put it in the last post (or a later reply), not the first.
- **Images:** PNG, JPEG, WebP or GIF, ≤ 5 MB; per-platform counts and types in the table above. Always write alt text.
- **Their language.** Write in the language the user writes in. Don't translate unless asked.
- **Never invent** statistics, quotes, sources, links or experiences the user didn't give you.

## Counting and limits

- X's limit is 280 for standard accounts; a Premium account has its own limit set on the account. Other platforms: the table above.
- X weighs characters: most Latin text counts 1; CJK characters and each emoji count 2; every URL counts 23.
  Vietnamese letters from Unicode's Latin Extended Additional block (ạ, ả, ấ, ầ, ệ, ố, ộ, ở, ữ, ự, ỳ…) count 2,
  while á, à, ã, é, í, ó, ú, ý, â, ê, ô, ơ, ư, ă, đ count 1, so Vietnamese posts fill up sooner than they look.
  Don't count by eye; use `count` / `count_characters`.

## Honest constraints

- **X's API costs money per post** (every other platform is free). On X's pay-per-use API each post costs about $0.015, and a post containing a URL
  about $0.20. A thread is billed per post (6 posts ≈ $0.09). Avoid gratuitous links; mention the cost when the user
  publishes something long or link-heavy.
- **Publishing is public and irreversible.** With approval on, `publish` / `publish_now` asks the user and goes out once they
  approve; with approval off, only use them when the user explicitly asks to post now. You can never approve.
  Deleting in Yaypost never removes anything already published anywhere.
- **Failed threads resume.** `retry` continues after the last item that went out on each destination, so it doesn't duplicate.
  Posts already live are locked: an edit that changes, removes or reorders them is refused (409); edit only the
  posts after them.
- **Missed times are not posted late unattended.** If the server was off when a post was due and it is more than
  `lateGraceMinutes` (default 60) late, it becomes `due` with `error` explaining why. Ask the user whether to
  publish it now (`retry`), post it by hand (`yaypost copy`, then `posted`), or reschedule it.
- **Approval is enforced by the server**, not by these instructions: pending and sent-back posts never publish, and
  deciding needs the user. Don't look for ways around it; if something must go out urgently, say so in the post's title.
