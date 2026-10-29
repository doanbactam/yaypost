// Bluesky rich text: link, hashtag and mention facets with UTF-8 byte offsets (app.bsky.richtext.facet).

type Feature = { $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string } | { $type: "app.bsky.richtext.facet#mention"; did: string };
export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Feature[];
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const slice = (text: string, start: number, end: number) => ({ byteStart: bytes(text.slice(0, start)), byteEnd: bytes(text.slice(0, end)) });

/** Link, hashtag and mention facets with UTF-8 byte offsets; mentions only when the handle resolves to a DID. */
export async function detectFacets(text: string, resolve?: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const facets: Facet[] = [];
  for (const m of text.matchAll(/(^|[\s(])(https?:\/\/[^\s]+)/gi)) {
    let url = m[2];
    url = url.replace(/[.,;:!?'"]+$/, "");
    const unbalanced = (u: string) => u.endsWith(")") && u.split(")").length > u.split("(").length;
    while (unbalanced(url)) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
    const start = m.index + m[1].length;
    facets.push({ index: slice(text, start, start + url.length), features: [{ $type: "app.bsky.richtext.facet#link", uri: url }] });
  }
  for (const m of text.matchAll(/(^|\s)([#＃])([^\s#＃]+)/gu)) {
    const tag = m[3].replace(/\p{P}+$/u, "");
    if (!tag || /^\d+$/.test(tag) || [...tag].length > 64) continue;
    const start = m.index + m[1].length;
    facets.push({ index: slice(text, start, start + m[2].length + tag.length), features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  if (resolve) {
    for (const m of text.matchAll(/(^|[\s(])@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g)) {
      const handle = m[2].replace(/\.+$/, "");
      if (!/\.[a-zA-Z][a-zA-Z0-9-]*$/.test(handle)) continue;
      const did = await resolve(handle.toLowerCase());
      if (!did) continue;
      const start = m.index + m[1].length;
      facets.push({ index: slice(text, start, start + 1 + handle.length), features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
    }
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
