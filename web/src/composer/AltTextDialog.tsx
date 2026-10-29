// Alt text editor for one image.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { Dialog } from "../components/Dialog.tsx";
import { toast, toastError } from "../components/Toasts.tsx";

const ALT_LIMIT = 1000; // X's alt text limit

export function AltTextDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: media, isPending } = useQuery({ queryKey: ["media", mediaId], queryFn: () => api.getMedia(mediaId), staleTime: Infinity });
  const [alt, setAlt] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Runs after the Dialog's showModal() (child effects run first), which would otherwise move focus to Close.
  useEffect(() => {
    if (!isPending) field.current?.focus();
  }, [isPending]);

  useEffect(() => {
    if (media?.alt) setAlt(media.alt);
  }, [media?.alt]);

  const save = useMutation({
    mutationFn: () => api.updateMediaAlt(mediaId, alt.trim() || null),
    onSuccess: (m) => {
      qc.setQueryData(["media", mediaId], m);
      toast({ title: m.alt ? "Alt text saved" : "Alt text removed", tone: "success" });
      onClose();
    },
    onError: (e) => toastError("Couldn't save alt text", e),
  });


  return (
    <Dialog title="Image description" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-3"
      >
        <img src={`/media/${mediaId}`} alt="" className="max-h-64 w-full rounded-xl border border-line bg-subtle object-contain" />
        <div className="relative">
          <textarea
            ref={field}
            value={alt}
            disabled={isPending}
            maxLength={ALT_LIMIT}
            rows={4}
            onChange={(e) => {
              setAlt(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault(); // handled here: the composer's Ctrl+Enter (add to queue) must not also run
                save.mutate();
              }
            }}
            placeholder="Describe the image for people who can't see it."
            className="w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2 text-sm leading-relaxed focus:border-line-strong"
          />
          <span className="absolute right-3 bottom-2 text-xs text-ink-3 tabular-nums">
            {alt.length}/{ALT_LIMIT}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:bg-subtle">
            Cancel
          </button>
          <button
            type="submit"
            disabled={save.isPending}
            className="rounded-lg bg-ink px-3.5 py-1.5 text-sm font-medium text-canvas hover:opacity-90 disabled:opacity-60"
          >
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
