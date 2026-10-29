// Encryption at rest for account credentials (AES-256-GCM). The key comes from SECRET_KEY, or is generated once
// into <DATA_DIR>/secret.key (mode 0600). Back that file up with the database: without it, credentials can't be read.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env.ts";

let key: Buffer | undefined;

function getKey(): Buffer {
  if (key) return key;
  const fromEnv = process.env.SECRET_KEY?.trim();
  if (fromEnv) return (key = createHash("sha256").update(fromEnv).digest());
  const file = path.join(env.dataDir, "secret.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  return (key = createHash("sha256").update(readFileSync(file, "utf8").trim()).digest());
}

/** "v1.<iv>.<tag>.<ciphertext>", all base64url. */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function open(sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unreadable credentials (unknown format)");
  try {
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Can't decrypt stored credentials: SECRET_KEY or data/secret.key changed. Reconnect the account.");
  }
}

/** HMAC-SHA256 (base64url) with a key derived from the same secret, for short-lived signed links. */
export function sign(data: string): string {
  return createHmac("sha256", getKey()).update(`sig:${data}`).digest("base64url");
}

export function verifySignature(data: string, signature: string): boolean {
  const a = Buffer.from(sign(data));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
