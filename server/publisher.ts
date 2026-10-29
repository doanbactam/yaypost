// Publishing a post to its connected accounts. Each destination is checked up front, then posted independently and
// resumably: a failure on one platform doesn't stop the others, and Retry only redoes what didn't go out.
import { countWith } from "../shared/counting.ts";
import type { Account, Post, PostTarget } from "../shared/types.ts";
import { accountCredentials, getAccount, setAccountError } from "./accounts.ts";
import type { PublishItem } from "./plugin-api.ts";
import { hasPlatform, itemsFor, platform, platformName } from "./plugins.ts";
import { getMedia, markFailed, markPublished, markTargetFailed, markTargetPublished, recordTargetProgress, requirePost } from "./repo.ts";

export function limitFor(account: Account): number {
  return account.maxChars ?? platform(account.platform).maxChars;
}

/** Everything that would make the platform reject an item, found before anything is posted. */
export function preflight(account: Account, items: PublishItem[], offset = 0): string | null {
  const info = platform(account.platform);
  const limit = limitFor(account);
  for (const [i, item] of items.entries()) {
    const n = items.length + offset > 1 ? `Post ${i + 1 + offset}` : "The post";
    const where = items.length + offset > 1 ? ` in post ${i + 1 + offset}` : "";
    if (!item.text.trim() && !item.mediaIds.length) return `${n} is empty; add text or remove it.`;
    const captionLimit = item.mediaIds.length && info.maxCharsWithMedia ? Math.min(limit, info.maxCharsWithMedia) : limit;
    const length = countWith(platform(account.platform).counting, item.text);
    if (length > captionLimit) {
      return `${n} is ${length}/${captionLimit} characters on ${info.name}${captionLimit !== limit ? " (photo captions are limited)" : ""}; shorten it or give ${info.name} its own version.`;
    }
    if (item.mediaIds.length > info.maxImages) return `${n} has ${item.mediaIds.length} images; ${info.name} allows at most ${info.maxImages}.`;
    if (info.maxImageBytes) {
      const big = item.mediaIds.map(getMedia).find((m) => m && m.size > info.maxImageBytes!);
      if (big) return `${big.filename}${where} is ${(big.size / 1e6).toFixed(1)} MB; ${info.name} accepts images up to ${info.maxImageBytes / 1e6} MB.`;
    }
    if (info.imageTypes) {
      const bad = item.mediaIds.map(getMedia).find((m) => m && !info.imageTypes!.includes(m.mime));
      if (bad) return `${info.name} doesn't accept ${bad.mime.replace("image/", "").toUpperCase()} images (${bad.filename}${where}); use ${info.imageTypes.map((t) => t.replace("image/", "").toUpperCase()).join(" or ")}.`;
    }
  }
  return null;
}

async function publishTarget(post: Post, target: PostTarget): Promise<string | null> {
  const name = platformName(target.platform);
  let account: Account;
  try {
    account = getAccount(target.accountId);
  } catch {
    return `${name}: the account was removed.`;
  }
  if (!hasPlatform(account.platform)) {
    const message = `No loaded plugin provides ${name}; install or enable it, then Retry.`;
    markTargetFailed(post.id, account.id, message);
    return `${account.label}: ${message}`;
  }
  const items = itemsFor(platform(account.platform), target.thread ?? post.thread);
  const problem = preflight(account, items.slice(target.externalIds.length), target.externalIds.length);
  if (problem) {
    markTargetFailed(post.id, account.id, `${problem} Nothing more was posted there.`);
    return `${account.label}: ${problem}`;
  }
  try {
    const result = await platform(account.platform).publish({
      postId: post.id,
      account,
      credentials: accountCredentials(account.id),
      items,
      posted: target.externalIds,
      record: (ids) => recordTargetProgress(post.id, account.id, ids),
    });
    markTargetPublished(post.id, account.id, { externalIds: result.ids, url: result.url, posted: target.thread ?? post.thread });
    setAccountError(account.id, null);
    console.log(`[publish] ${post.id} → ${account.label}: ${result.url ?? "ok"}`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const done = requirePost(post.id).targets.find((t) => t.accountId === account.id)?.externalIds.length ?? 0;
    // Plugins throw ts.PlatformError (status, resumable); anything else counts as resumable.
    const { status, resumable = true } = err as { status?: number; resumable?: boolean };
    const progress =
      done && done < items.length
        ? ` ${done} of ${items.length} ${done === 1 ? "is" : "are"} live on ${name}${resumable ? "; Retry continues after them" : ""}.`
        : "";
    markTargetFailed(post.id, account.id, message + progress);
    if (status === 401 || status === 403) setAccountError(account.id, message);
    console.error(`[publish] ${post.id} → ${account.label} failed: ${message}`);
    return `${account.label}: ${message}${progress}`;
  }
}

/** Publish a claimed (`publishing`) post to every destination not yet published; never throws. */
export async function publishTargets(post: Post): Promise<Post> {
  if (!post.targets.length) return markFailed(post.id, "This post has no destinations. Choose at least one connected account, then Retry.");
  const problems: string[] = [];
  for (const target of post.targets) {
    if (target.status === "published") continue;
    const problem = await publishTarget(post, target);
    if (problem) problems.push(problem);
  }
  const after = requirePost(post.id);
  const first = after.targets.find((t) => t.url)?.url ?? null;
  if (!problems.length) return markPublished(post.id, first);
  const ok = after.targets.filter((t) => t.status === "published").length;
  return markFailed(post.id, `${ok} of ${after.targets.length} destinations published. ${problems.join(" · ")}`);
}
