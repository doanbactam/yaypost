// One post in the thread: chrome-less auto-growing textarea, per-platform counter, images, drag handle.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GripVertical, ImagePlus, LoaderCircle, Lock, Trash2, TriangleAlert, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Segment } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { strictest, type Meter } from "../lib/platforms.tsx";
import { Tip } from "../components/Tip.tsx";
import { cx } from "../lib/util.ts";
import { CharRing } from "./CharRing.tsx";

export const MAX_IMAGES = 4; // X's limit, the default when no other destination is selected

export interface ImageRule {
  name: string;
  types?: string[];
  maxBytes?: number;
}

export interface PendingUpload {
  key: string;
  url: string;
}

interface Props {
  segment: Segment;
  index: number;
  total: number;
  /** One counter per destination platform (just X in single-X mode); the ring shows the strictest. */
  meters: Meter[];
  maxImages: number;
  /** Selected platforms that accept only some image types (Threads, LinkedIn) or sizes (Bluesky): a thumbnail they'd refuse is flagged. */
  imageRules: ImageRule[];
  readOnly: boolean;
  /** Set when this post is already live (a thread that stopped partway): shown locked, with a link when known. */
  live?: { where: string; url: string | null };
  uploads: PendingUpload[];
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  onChange: (text: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onRemove: () => void;
  onFiles: (files: File[]) => void;
  onRemoveImage: (mediaId: string) => void;
  onEditImage: (mediaId: string) => void;
}

const imageFiles = (list: FileList | null | undefined) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

export function PostCard(p: Props) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: p.segment.id,
    disabled: p.readOnly,
  });
  const local = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

  const ring = strictest(p.meters);
  const overOn = p.meters.filter((m) => m.length > m.max);
  const over = overOn.length > 0;
  const imageCount = p.segment.mediaIds.length + p.uploads.length;
  const canAddImage = !p.readOnly && imageCount < p.maxImages;

  useLayoutEffect(() => {
    const el = local.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    addEventListener("resize", fit);
    return () => removeEventListener("resize", fit);
  }, [p.segment.text]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("group/card relative flex gap-3 pb-3", isDragging && "z-10")}
    >
      <div className="flex w-7 shrink-0 flex-col items-center pt-3">
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={p.readOnly ? `Post ${p.index + 1}` : `Post ${p.index + 1}. Press space to reorder with arrow keys`}
          disabled={p.readOnly}
          className={cx(
            "relative grid size-7 shrink-0 touch-none place-items-center rounded-full border border-line bg-surface text-xs font-medium text-ink-3 tabular-nums",
            !p.readOnly && "cursor-grab hover:border-line-strong hover:text-ink active:cursor-grabbing",
          )}
        >
          <span className={cx(!p.readOnly && "group-hover/card:opacity-0 group-focus-within/card:opacity-0 [@media(hover:none)]:opacity-0")}>
            {p.index + 1}
          </span>
          {!p.readOnly && (
            <GripVertical
              size={14}
              className="absolute opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100"
            />
          )}
        </button>
        {p.index < p.total - 1 && <div className="mt-1.5 -mb-3 w-px flex-1 bg-line" />}
      </div>

      <div
        onDragOver={(e) => {
          if (!canAddImage || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          setDropping(false);
          const files = imageFiles(e.dataTransfer.files);
          if (!files.length || !canAddImage) return;
          e.preventDefault();
          p.onFiles(files);
        }}
        className={cx(
          "min-w-0 flex-1 rounded-2xl border bg-surface px-4 pt-3 pb-2 transition-[border-color,box-shadow]",
          isDragging && "shadow-xl shadow-black/10",
          over
            ? "border-red-300 focus-within:border-red-400 dark:border-red-900 dark:focus-within:border-red-700"
            : isDragging
              ? "border-line-strong"
              : cx("border-line", !p.readOnly && "focus-within:border-line-strong focus-within:shadow-sm"),
          dropping && "border-ai ring-2 ring-ai/30",
        )}
      >
        <textarea
          ref={(el) => {
            local.current = el;
            p.textareaRef(el);
          }}
          value={p.segment.text}
          readOnly={p.readOnly}
          rows={p.index === 0 ? 3 : 2}
          spellCheck
          placeholder={p.index === 0 ? "What do you want to say?" : `Post ${p.index + 1}`}
          aria-label={`Post ${p.index + 1} of ${p.total}`}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={p.onKeyDown}
          onFocus={p.onFocus}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData.files);
            if (!files.length) return;
            e.preventDefault();
            if (canAddImage) p.onFiles(files);
          }}
          className="block w-full resize-none overflow-hidden bg-transparent text-base leading-relaxed text-ink placeholder:text-ink-3 sm:text-[17px]"
        />

        {imageCount > 0 && (
          <div className={cx("mt-2 grid gap-1.5", imageCount === 1 ? "grid-cols-1" : "grid-cols-2")}>
            {p.segment.mediaIds.map((id) => (
              <Thumb
                key={id}
                id={id}
                single={imageCount === 1}
                rules={p.imageRules}
                readOnly={p.readOnly}
                onEdit={() => p.onEditImage(id)}
                onRemove={() => p.onRemoveImage(id)}
              />
            ))}
            {p.uploads.map((u) => (
              <div key={u.key} className={cx("relative overflow-hidden rounded-xl bg-subtle", imageCount === 1 ? "aspect-video" : "aspect-square")}>
                <img src={u.url} alt="" className="size-full object-cover opacity-50" />
                <LoaderCircle size={20} className="absolute inset-0 m-auto animate-spin text-ink-2" />
              </div>
            ))}
          </div>
        )}

        {p.live && (
          <div className="mt-1 flex h-8 items-center gap-1.5 text-xs text-ink-3">
            <Lock size={12} /> Live on {p.live.where} · can't be changed
            <div className="flex-1" />
            {p.live.url && (
              <a href={p.live.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-subtle hover:text-ink">
                View <ExternalLink size={12} />
              </a>
            )}
          </div>
        )}
        {!p.readOnly && (
          <div className="mt-1 flex min-h-8 items-center gap-1 text-ink-3">
            <Tip content={canAddImage ? "Add image, or paste / drop one" : `Up to ${p.maxImages} images per post`}>
              <span className="inline-flex">
                <button
                  onClick={() => fileInput.current?.click()}
                  disabled={!canAddImage}
                  aria-label="Add image"
                  className="rounded-md p-1.5 hover:bg-subtle hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <ImagePlus size={16} />
                </button>
              </span>
            </Tip>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                const files = imageFiles(e.target.files);
                e.target.value = "";
                if (files.length) p.onFiles(files);
              }}
            />
            {p.meters.length > 1 && (
              <span
                className="flex min-w-0 flex-1 flex-wrap gap-x-2.5 gap-y-0.5 py-1 pl-1 text-[11px] leading-4 tabular-nums"
                aria-label="Characters per destination"
              >
                {p.meters.map((m) => (
                  <span key={m.key} className={cx("whitespace-nowrap", m.length > m.max && "font-medium text-red-600 dark:text-red-400")}>
                    {m.label} {m.length}/{m.max}
                  </span>
                ))}
              </span>
            )}
            {p.meters.length <= 1 && <div className="flex-1" />}
            {p.total > 1 && (
              <button
                onClick={p.onRemove}
                aria-label={`Delete post ${p.index + 1}`}
                className="rounded-md p-1.5 opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 hover:bg-subtle hover:text-red-600 focus:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Trash2 size={15} />
              </button>
            )}
            {ring && <CharRing length={ring.length} max={ring.max} platform={p.meters.length > 1 || ring.platform !== "x" ? ring.label : undefined} named={p.meters.length === 1} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Thumb(p: {
  id: string;
  single: boolean;
  rules: ImageRule[];
  readOnly: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { data: media } = useQuery({ queryKey: ["media", p.id], queryFn: () => api.getMedia(p.id), staleTime: Infinity });
  const hasAlt = Boolean(media?.alt);
  const refusedBy = media ? p.rules.filter((r) => r.types && !r.types.includes(media.mime)).map((r) => r.name) : [];
  const tooBig = media ? p.rules.filter((r) => r.maxBytes && media.size > r.maxBytes) : [];
  const kind = media?.mime.replace("image/", "").toUpperCase();
  const mb = (n: number) => `${(n / 1e6).toFixed(1).replace(/\.0$/, "")} MB`;
  return (
    <div className={cx("group/img relative overflow-hidden rounded-xl border border-line bg-subtle", p.single ? "aspect-video" : "aspect-square")}>
      {p.readOnly ? (
        <img src={`/media/${p.id}`} alt={media?.alt ?? ""} className="size-full object-cover" draggable={false} />
      ) : (
        <button onClick={p.onEdit} className="block size-full" aria-label={hasAlt ? `Edit alt text: ${media!.alt}` : "Add alt text"}>
          <img src={`/media/${p.id}`} alt={media?.alt ?? ""} className="size-full object-cover" draggable={false} />
        </button>
      )}
      {(hasAlt || !p.readOnly) && (
        <span
          className={cx(
            "pointer-events-none absolute bottom-2 left-2 rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
            hasAlt ? "bg-black/70 text-white" : "border border-dashed border-white/80 bg-black/40 text-white/90",
          )}
        >
          {hasAlt ? "ALT" : "+ ALT"}
        </span>
      )}
      {(refusedBy.length > 0 || tooBig.length > 0) && (
        <div className="absolute top-2 left-2 flex max-w-[calc(100%-3rem)] flex-col items-start gap-1">
          {refusedBy.length > 0 && (
            <span
              role="note"
              title={`${refusedBy.join(" and ")} ${refusedBy.length > 1 ? "don't" : "doesn't"} accept ${kind} images. Use a JPEG or PNG, or give ${refusedBy.length > 1 ? "them their" : "it its"} own version without this image.`}
              className="flex items-center gap-1 rounded bg-amber-500/95 px-1.5 py-0.5 text-[10px] leading-tight font-semibold text-black"
            >
              <TriangleAlert size={11} /> {kind} not accepted on {refusedBy.join(", ")}
            </span>
          )}
          {media && tooBig.length > 0 && (
            <span
              role="note"
              title={`${mb(media.size)} is over the limit of ${tooBig.map((r) => `${r.name} (${mb(r.maxBytes!)})`).join(" and ")}. Use a smaller image, or give ${tooBig.length > 1 ? "them their" : "it its"} own version without this image.`}
              className="flex items-center gap-1 rounded bg-amber-500/95 px-1.5 py-0.5 text-[10px] leading-tight font-semibold text-black"
            >
              <TriangleAlert size={11} /> {mb(media.size)}: over {tooBig.map((r) => `${r.name}'s ${mb(r.maxBytes!)}`).join(", ")}
            </span>
          )}
        </div>
      )}
      {!p.readOnly && (
        <button
          onClick={p.onRemove}
          aria-label="Remove image"
          className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur transition-opacity group-hover/img:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
