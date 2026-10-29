// Thread text helpers: "---" splitting and X's weighted character count.

/** A line containing only "---" separates posts in a thread. */
const SEPARATOR = /^\s*-{3,}\s*$/m;

export function splitThread(text: string): string[] {
  return text
    .split(new RegExp(SEPARATOR.source, "gm"))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function joinThread(parts: string[]): string {
  return parts.map((p) => p.trim()).join("\n\n---\n\n");
}

// X counts text with twitter-text v3 rules: NFC-normalised, most Latin/Greek/Cyrillic code points
// weigh 1, everything else (CJK, and also precomposed Vietnamese letters such as "ệ" U+1EC7) weighs 2,
// each emoji weighs 2, and every URL counts as 23 regardless of length.
const LIGHT_RANGES: Array<[number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const URL_WEIGHT = 23;
// Approximation of twitter-text's URL extractor: explicit schemes plus bare domains on common TLDs. Like
// twitter-text, a URL is made of ASCII/Latin/Cyrillic characters only (so "https://x.co/a日本" ends before 日),
// trailing punctuation is not part of it, and a bare domain inside an email or another URL is not a link.
const URL_CHARS = "[\\w\\-.~!*';:=+,$/%#\\[\\]&|@?()\\u00C0-\\u024F\\u0400-\\u04FF\\u1E00-\\u1EFF]";
const URL_RE = new RegExp(
  `\\bhttps?:\\/\\/${URL_CHARS}+|(?<![\\w@./:-])(?:[a-z0-9-]+\\.)+(?:com|net|org|io|ai|dev|app|co|me|xyz|vn|gg|so|sh|tv|ly|to|us|uk|de|fr|jp)\\b(?:\\/${URL_CHARS}*)?`,
  "gi",
);
const TRAILING_PUNCT = /[.,!?;:'")\]]+$/;
// Emoji (incl. flags, which are pairs of regional indicators) count 2 per grapheme.
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;

function codePointWeight(cp: number): number {
  for (const [lo, hi] of LIGHT_RANGES) if (cp >= lo && cp <= hi) return 1;
  return 2;
}

function plainWeight(text: string): number {
  let total = 0;
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) {
      if (EMOJI_RE.test(segment)) total += 2;
      else for (const ch of segment) total += codePointWeight(ch.codePointAt(0)!);
    }
  } else {
    for (const ch of text) total += codePointWeight(ch.codePointAt(0)!);
  }
  return total;
}

/** Weighted length as X counts it (limit 280 for standard accounts). */
export function weightedLength(raw: string): number {
  const text = raw.normalize("NFC");
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT, "");
    total += plainWeight(text.slice(last, m.index)) + URL_WEIGHT;
    last = m.index! + url.length;
  }
  return total + plainWeight(text.slice(last));
}

export function hasUrl(text: string): boolean {
  return new RegExp(URL_RE.source, "i").test(text);
}

/** Plain-text export used by "copy thread" and agents: posts separated by blank-line + --- lines. */
export function threadToText(segments: { text: string }[]): string {
  return joinThread(segments.map((s) => s.text));
}
