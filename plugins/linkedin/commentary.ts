// LinkedIn "little text format" for post commentary (learn.microsoft.com/linkedin … little-text-format).

/** little-text reserved characters; all must be backslash-escaped to stay plain text. */
const RESERVED = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string) => s.replace(RESERVED, (c) => `\\${c}`);

/** Commentary in little format: everything escaped, except #words, which stay real hashtags via the hashtag template. */
export function toCommentary(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/(?<![\p{L}\p{N}_&#\\])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu)) {
    out += escapeLittle(text.slice(last, m.index)) + `{hashtag|\\#|${escapeLittle(m[1])}}`;
    last = m.index + m[0].length;
  }
  return out + escapeLittle(text.slice(last));
}
