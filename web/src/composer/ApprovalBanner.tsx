// Above the thread when an agent's post needs the person: waiting for approval (decide right here), or sent back
// to the agent (the note), or rejected earlier (the reason).
import { MessageSquareReply, ShieldQuestion, X } from "lucide-react";
import type { Post } from "../../../shared/types.ts";
import { DecisionBar } from "../components/Approval.tsx";
import { askerLabel, deciderLabel } from "../lib/actors.ts";
import { formatWhen, timeAgo } from "../lib/time.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ApprovalBanner({ post, tz, flush, onChange }: { post: Post; tz: string; flush: () => Promise<void>; onChange: (post: Post) => void }) {
  const a = post.approval;
  if (!a) return null;
  if (a.state === "pending") {
    const when = post.scheduledAt && Date.parse(post.scheduledAt) > Date.now() ? formatWhen(post.scheduledAt, tz) : null;
    return (
      <div className="mb-4 ml-10 space-y-2.5 rounded-xl border border-violet-200 bg-violet-50 px-3.5 py-3 text-sm text-violet-950 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-50">
        <div className="flex items-start gap-2">
          <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-400" />
          <p className="min-w-0">
            <span className="font-medium">Waiting for your approval.</span>{" "}
            <span className="opacity-80">
              {askerLabel(post)} asked {a.at ? timeAgo(a.at) : "earlier"}. {when ? `If approved, it goes out ${when}.` : "If approved, it goes out right away."}
            </span>
          </p>
        </div>
        <DecisionBar post={post} tz={tz} before={flush} onDone={onChange} />
      </div>
    );
  }
  if (a.state === "changes_requested")
    return (
      <div className="mb-4 ml-10 flex items-start gap-2 rounded-xl border border-orange-200 bg-orange-50 px-3.5 py-3 text-sm text-orange-950 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-50">
        <MessageSquareReply size={16} className="mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
        <div className="min-w-0">
          <p className="font-medium">Sent back to the agent</p>
          {a.note && (
            <p className="mt-0.5 break-words">
              {cap(deciderLabel(a.by))} asked: “{a.note}”
            </p>
          )}
        </div>
      </div>
    );
  if (a.state === "rejected" && post.status === "draft")
    return (
      <p className="mb-3 ml-10 flex items-center gap-1.5 text-xs text-ink-3">
        <X size={13} /> Rejected by {deciderLabel(a.by)}
        {a.at ? ` ${timeAgo(a.at)}` : ""}
        {a.note ? `: “${a.note}”` : ""}
      </p>
    );
  return null;
}
