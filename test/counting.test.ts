// Expected lengths come from each platform's documented rules, not from running this code:
// X (twitter-text v3): any URL weighs 23; code points outside the Latin/punctuation ranges (CJK, precomposed
// Vietnamese such as U+1EC7 "ệ") weigh 2; an emoji, modifiers included, weighs 2.
// Bluesky: user-perceived characters (graphemes). Mastodon: code points, any URL counts as 23.
// Threads: code points, but an emoji counts as its UTF-8 byte length.
import { describe, expect, test } from "vitest";
import { countWith } from "../shared/counting.ts";

const longUrl = "https://example.com/" + "a".repeat(100);

describe("X (x-weighted)", () => {
  const x = { method: "x-weighted" } as const;
  test("a URL weighs 23 whatever its length", () => {
    expect(countWith(x, longUrl)).toBe(23);
    expect(countWith(x, "see example.com")).toBe(4 + 23);
    expect(countWith(x, "https://example.com/very/long/path ạ")).toBe(26);
  });
  test("CJK, Vietnamese letters and emoji weigh 2", () => {
    expect(countWith(x, "日本語")).toBe(6);
    expect(countWith(x, "Việt")).toBe(5);
    expect(countWith(x, "Vie\u0323\u0302t")).toBe(5); // decomposed ệ: normalised to the same 4 letters first
    expect(countWith(x, "👍🏽")).toBe(2);
  });
});

test("Bluesky (graphemes): a family emoji is one character, links count in full", () => {
  const rule = { method: "graphemes" } as const;
  expect(countWith(rule, "👨‍👩‍👧")).toBe(1);
  expect(countWith(rule, "Việt")).toBe(4);
  expect(countWith(rule, longUrl)).toBe(longUrl.length);
});

test("Mastodon (code points, URL = 23)", () => {
  const rule = { method: "codepoints", urlLength: 23 } as const;
  expect(countWith(rule, `read ${longUrl}`)).toBe(5 + 23);
  expect(countWith(rule, "日本語👍")).toBe(4);
});

test("Threads (code points, emoji = UTF-8 bytes)", () => {
  const rule = { method: "codepoints", emoji: "utf8-bytes" } as const;
  expect(countWith(rule, "hi 👍")).toBe(3 + 4);
  expect(countWith(rule, "日本語")).toBe(3);
});
