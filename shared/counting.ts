// How platforms count characters, as data: a plugin declares its rule and every surface (server pre-flight, web
// counters, CLI, agents via GET /api/platforms) counts the same way without running plugin code.
import { weightedLength } from "./thread.ts";

export type CountingRule =
  /** X / twitter-text v3: weighted code points (CJK, emoji, Vietnamese ạ ệ ố… = 2), every URL = 23. */
  | { method: "x-weighted" }
  /** User-perceived characters (Bluesky). Links count in full. */
  | { method: "graphemes" }
  /**
   * Unicode code points. `urlLength`: every http(s) URL counts as this many (Mastodon: 23).
   * `emoji: "utf8-bytes"`: an emoji counts as its UTF-8 byte length (Threads).
   */
  | { method: "codepoints"; urlLength?: number; emoji?: "utf8-bytes" };

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;
const URL_ANY = /\bhttps?:\/\/\S+/gi;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function countWith(rule: CountingRule, text: string): number {
  switch (rule.method) {
    case "x-weighted":
      return weightedLength(text);
    case "graphemes": {
      const t = text.normalize("NFC");
      return segmenter ? [...segmenter.segment(t)].length : [...t].length;
    }
    case "codepoints": {
      const t = rule.urlLength ? text.replace(URL_ANY, "x".repeat(rule.urlLength)) : text;
      if (rule.emoji !== "utf8-bytes" || !segmenter) return [...t].length;
      let n = 0;
      for (const { segment } of segmenter.segment(t)) n += EMOJI.test(segment) ? new TextEncoder().encode(segment).length : [...segment].length;
      return n;
    }
  }
}
