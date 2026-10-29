// Image intake shared by REST and MCP: byte-sniffed type check, size cap, streaming download with a timeout.
import path from "node:path";
import type { Media } from "../shared/types.ts";
import { publicUrl } from "./env.ts";
import { BadInputError, createMedia, IMAGE_MIMES, MAX_IMAGE_BYTES } from "./repo.ts";
import { sign, verifySignature } from "./secrets.ts";

const FETCH_TIMEOUT_MS = 15_000;

/** Trust the bytes, not the declared type: only real PNG/JPEG/WebP/GIF data is stored and served. */
export function sniffImage(b: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
}

const tooBig = () => new BadInputError(`Image is larger than X's ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`);

export function saveImage(input: { data: Uint8Array; declared?: string; filename?: string; alt?: string | null }): Media {
  if (input.data.byteLength > MAX_IMAGE_BYTES) throw tooBig();
  const mime = sniffImage(input.data);
  if (!mime || !IMAGE_MIMES[mime]) throw new BadInputError(`Not a PNG, JPEG, WebP or GIF image (declared type: ${input.declared || "none"})`);
  return createMedia({ data: input.data, mime, filename: input.filename || undefined, alt: input.alt });
}

/** Stream an http(s) URL into memory, refusing anything over the image size limit before it is buffered. */
export async function downloadImage(url: string): Promise<{ data: Uint8Array; type: string; filename: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadInputError(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new BadInputError("Only http(s) image URLs are supported");
  try {
    const res = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "image/*" } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) throw tooBig();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (const reader = res.body.getReader(); ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((size += value.byteLength) > MAX_IMAGE_BYTES) {
        reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
    return { data: Buffer.concat(chunks), type: res.headers.get("content-type") ?? "", filename: path.posix.basename(new URL(res.url || url).pathname) };
  } catch (err) {
    if (err instanceof BadInputError) throw err;
    const e = err as Error & { cause?: Error };
    const reason = e.name === "TimeoutError" ? `no response within ${FETCH_TIMEOUT_MS / 1000}s` : (e.cause?.message ?? e.message);
    throw new BadInputError(`Could not fetch ${url}: ${reason}`);
  }
}

/** Download + validate + store. */
export async function saveImageFromUrl(url: string, alt?: string | null): Promise<Media> {
  const img = await downloadImage(url);
  return saveImage({ data: img.data, declared: img.type, filename: img.filename, alt });
}

/**
 * A link a platform's servers can fetch an image from (Threads takes images by URL), valid for `ttlSeconds` without
 * AUTH_TOKEN. It is built on PUBLIC_URL, which must be reachable from the internet for this to work.
 */
export function signedMediaUrl(id: string, ttlSeconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `${publicUrl()}/media/${id}?exp=${exp}&sig=${sign(`${id}.${exp}`)}`;
}

export function validMediaSignature(id: string, exp: string | undefined, sig: string | undefined): boolean {
  return Boolean(exp && sig && Number(exp) * 1000 > Date.now() && verifySignature(`${id}.${exp}`, sig));
}
