// Writing guide for agents, served as the MCP resource yaypost://guide and inside /llms-full.txt.
import type { PlatformDefinition } from "../plugin-api.ts";
import { listPlatforms } from "../plugins.ts";
import { getConfig } from "../config.ts";

/** The platform's counting rule in words. */
function counting(p: PlatformDefinition): string {
  const r = p.counting;
  const base =
    r.method === "x-weighted"
      ? "weighted: CJK, emoji and Vietnamese letters like ạ ệ ố 2; URLs 23"
      : r.method === "graphemes"
        ? "graphemes (an emoji or ệ is 1); URLs count in full"
        : ["code points", r.urlLength ? `every URL ${r.urlLength}` : "", r.emoji === "utf8-bytes" ? "each emoji its UTF-8 bytes (usually 4)" : ""].filter(Boolean).join("; ");
  const extra = [p.threadMode === "single" ? "the thread is joined into ONE post" : "", p.maxCharsWithMedia ? `${p.maxCharsWithMedia} for an item with images` : ""];
  return [base, ...extra].filter(Boolean).join("; ");
}
const MODE = { replies: "reply chain", single: "joined into one post", messages: "consecutive messages" };

/** Markdown table of every platform's limits, counting, thread mode and cost (shared by the guide and llms.txt). */
export function platformTable(): string {
  const rows = listPlatforms().map((p) => {
    const limit = String(p.maxChars);
    const images = `${p.maxImages}${p.imageTypes ? ` (${p.imageTypes.map((t) => t.replace("image/", "")).join("/")})` : ""}`;
    return `| ${p.name} | ${limit} | ${counting(p)} | ${images} | ${MODE[p.threadMode]} | ${p.costNote} |`;
  });
  return ["| Platform | Limit per post | Counting | Images per post | A thread becomes | Cost |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function threadGuide(): string {
  const { timezone, lateGraceMinutes } = getConfig();
  const late =
    lateGraceMinutes > 0
      ? `- A scheduled post that missed its time by more than ${lateGraceMinutes} minutes (Yaypost was offline) is not posted late unattended:
  it becomes **due**, with an \`error\` saying why. Ask the person whether to publish it now, copy it, or reschedule it.\n`
      : "- A scheduled post that missed its time while Yaypost was offline is published as soon as Yaypost is back.\n";
  return `# Writing threads with Yaypost

## Format and limits
- A thread is one text with a line containing only \`---\` between posts (or an array of posts). A single post is a thread of one.
- Each platform has its own per-post limit and counts its own way (table below); an account can override its limit (e.g. X Premium).
  X weighs characters: most Latin letters, digits and punctuation count 1; CJK characters and each emoji count 2; Vietnamese letters
  from Unicode's Latin Extended Additional block (ạ, ả, ấ, ệ, ố, ở, ữ…) count 2, while á, à, ã, é, ó, ơ, ư, đ and the like count 1; every link counts 23.
  Check with the \`count_characters\` tool (MCP) or \`yaypost count\` (CLI) before saving or scheduling.
- Images: png, jpeg, webp or gif, ≤ 5 MB each; how many per post depends on the platform (table below). Give every image alt text.
- Times are ISO-8601 date-times in the future: \`2026-11-03T09:00\` is read in the configured timezone (${timezone});
  \`2026-11-03T09:00:00+07:00\` or \`2026-11-03T02:00:00Z\` is exact. Dates without a time are rejected. \`"next"\` means the next free posting slot from yaypost.config.json.

## Destinations (connected accounts)
- A post goes to the connected accounts in its \`targets\` (MCP: \`to\`, by id, label, handle or platform name; CLI: \`--to\`). Each destination
  publishes, fails and resumes on its own; the post is published when all are, failed when any is (see each destination's error).
- A post needs at least one destination to be scheduled or published; without one it stays a draft.
- Each destination can get its own version of the thread (MCP \`versions\`, CLI \`--version ref=file\`, REST \`targets[].thread\`), e.g. a
  tighter X thread and one long LinkedIn post. Without one it publishes the main thread, so the main thread must fit every destination.
- Platforms count differently: the same Vietnamese post can fit Bluesky (300 graphemes) and be over on X (280 weighted). Check each destination
  with \`preview_post\` / \`yaypost preview\` / \`GET /api/posts/{id}/preview\` before scheduling.
- Connecting an account needs the person's secrets: they do it in the UI (or \`POST /api/accounts\`). Never ask them to paste tokens into a chat.

${platformTable()}

## How publishing works on this instance
${late}- If a thread fails partway through publishing, the posts already live on a destination are locked: they can't be edited, removed or reordered.
  Fix only the posts after them, then retry; it resumes after the last live post on each destination.
- On X's pay-per-use API each post costs about $0.015, and a post that contains a link about $0.20. A 6-post thread is 6 posts.
  Every other platform is free to post to.
  Avoid gratuitous links; if the person wants a link, put it in the last post (or a reply) rather than the first.

## What makes a thread work
1. **The first post is the whole game.** Most people only see it in their timeline. Lead with the most concrete, surprising
   or useful thing: a result, a number, a strong claim, a moment. It must make sense alone. Skip "A thread 🧵" and "Here's what I learned".
2. **One idea per post.** Each post should still make sense if someone lands on it from a quote or a reply.
3. **Specific beats general.** Names, numbers, examples and before/after beat adjectives. Cut hedges and filler.
4. **Short is a feature.** 3–8 posts is typical. Stop when the material runs out; don't pad to look substantial.
5. **Land it.** The last post states the takeaway. Add a call to action only when there's something real to do.
6. **Plain text.** X doesn't render Markdown. Use line breaks for rhythm. Hashtags and numbering ("1/") only if the person uses them.
7. **Their voice, their language.** Match the person's past posts (\`get_settings\` → voiceExamples) and write in the language they wrote in.
8. **Never invent facts**, quotes, statistics or links. If something is missing, ask.

## Workflow for agents
1. Draft. 2. Check counts and fix anything over the limit. 3. Show the person the thread and ask before scheduling or publishing.
4. Save with \`create_post\` (\`schedule: "next"\` or an ISO time) and report the scheduled time in their timezone.
5. Publishing immediately (\`publish_now\`) and deleting are irreversible; only do them when the person asked.
`;
}
