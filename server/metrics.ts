// Engagement data for agents. Yaypost only fetches and stores the numbers; deciding what they mean (what
// worked, when to post, what to plug or repost) is left to the AI reading them.
import type { ItemMetrics, Post, TargetMetrics } from "../shared/types.ts";
import { accountCredentials, getAccount } from "./accounts.ts";
import { hasPlatform, platform, platformName } from "./plugins.ts";
import { listPosts, requirePost, setTargetMetrics } from "./repo.ts";

const KEYS = ["likes", "reposts", "replies", "quotes", "views", "bookmarks"] as const;

function totals(items: ItemMetrics[]): TargetMetrics["totals"] {
  const out: TargetMetrics["totals"] = {};
  for (const k of KEYS) {
    const values = items.map((i) => i[k]).filter((v): v is number => typeof v === "number");
    if (values.length) out[k] = values.reduce((a, b) => a + b, 0);
  }
  return out;
}

export interface MetricsRefresh {
  post: Post;
  /** Per destination: why no fresh numbers (unsupported, paid and not allowed, error). */
  skipped: { accountId: string; platform: string; reason: string }[];
}

/**
 * Fetch current engagement for every published destination of a post and store it. Platforms that bill reads
 * (X) are only queried with `paid: true`.
 */
export async function refreshMetrics(postId: string, opts: { paid?: boolean } = {}): Promise<MetricsRefresh> {
  const post = requirePost(postId);
  const skipped: MetricsRefresh["skipped"] = [];
  for (const t of post.targets) {
    const name = platformName(t.platform);
    const skip = (reason: string) => skipped.push({ accountId: t.accountId, platform: t.platform, reason });
    if (t.status !== "published" || !t.externalIds.length) {
      skip("not published yet");
      continue;
    }
    if (!hasPlatform(t.platform)) {
      skip(`no loaded plugin provides ${name}`);
      continue;
    }
    const adapter = platform(t.platform);
    if (!adapter.metrics) {
      skip(`${name} has no engagement API for this kind of account`);
      continue;
    }
    if (adapter.metricsPaid && !opts.paid) {
      skip(adapter.metricsNote ?? `${name} bills these reads; pass paid=true to fetch`);
      continue;
    }
    try {
      const account = getAccount(t.accountId);
      const items = await adapter.metrics({ account, credentials: accountCredentials(account.id), externalIds: t.externalIds });
      setTargetMetrics(post.id, t.accountId, { fetchedAt: new Date().toISOString(), items, totals: totals(items) });
    } catch (err) {
      skip(err instanceof Error ? err.message : String(err));
    }
  }
  return { post: requirePost(postId), skipped };
}

/** Recently published posts with their stored numbers: the dataset an agent analyses. */
export function publishedWithMetrics(limit = 50): Post[] {
  return listPosts({ status: ["published"], limit });
}
