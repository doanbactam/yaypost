// Connected accounts: credentials are verified with the platform before they are stored, and stored encrypted.
import { randomUUID } from "node:crypto";
import type { Account, PlatformId } from "../shared/types.ts";
import { requireOwner } from "./actor.ts";
import { db } from "./db.ts";
import type { Credentials } from "./plugin-api.ts";
import { hasPlatform, platform, platformName } from "./plugins.ts";
import { BadInputError, ConflictError, httpUrl, NotFoundError } from "./repo.ts";
import { open, seal } from "./secrets.ts";

interface AccountRow {
  id: string;
  platform: PlatformId;
  label: string;
  handle: string | null;
  profile_url: string | null;
  max_chars: number | null;
  credentials: string;
  last_error: string | null;
  verified_at: string | null;
  created_at: string;
}

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  platform: r.platform,
  label: r.label,
  handle: r.handle,
  profileUrl: r.profile_url,
  maxChars: r.max_chars,
  lastError: r.last_error,
  verifiedAt: r.verified_at,
  createdAt: r.created_at,
});

const row = (id: string) => db.prepare("SELECT * FROM accounts WHERE id = ? AND removed_at IS NULL").get(id) as AccountRow | undefined;

export function listAccounts(): Account[] {
  return (db.prepare("SELECT * FROM accounts WHERE removed_at IS NULL ORDER BY created_at").all() as unknown as AccountRow[]).map(toAccount);
}

export function getAccount(id: string): Account {
  const r = row(id);
  if (!r) throw new NotFoundError(`Account ${id} not found`);
  return toAccount(r);
}

export function accountCredentials(id: string): Credentials {
  const r = row(id);
  if (!r) throw new NotFoundError(`Account ${id} not found`);
  return JSON.parse(open(r.credentials)) as Credentials;
}

/** Keep only the platform's fields, trimmed; require the non-optional ones. */
function cleanCredentials(platformId: PlatformId, input: Record<string, unknown>): Credentials {
  const out: Credentials = {};
  for (const f of platform(platformId).credentials) {
    const v = typeof input[f.key] === "string" ? (input[f.key] as string).trim() : "";
    if (v) out[f.key] = v;
    else if (!f.optional) throw new BadInputError(`${platformName(platformId)}: "${f.label}" (${f.key}) is required`);
  }
  return out;
}

async function verify(platformId: PlatformId, credentials: Credentials) {
  try {
    return await platform(platformId).verify(credentials);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BadInputError(`${platformName(platformId)} rejected these credentials: ${msg}`);
  }
}

export async function connectAccount(input: {
  platform: PlatformId;
  credentials: Record<string, unknown>;
  label?: string | null;
  maxChars?: number | null;
}): Promise<Account> {
  requireOwner("connect accounts");
  if (!hasPlatform(input.platform)) throw new BadInputError(`Unknown platform ${input.platform}; GET /api/platforms lists the loaded ones.`);
  const credentials = cleanCredentials(input.platform, input.credentials);
  const who = await verify(input.platform, credentials);
  const id = randomUUID();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts (id, platform, label, handle, profile_url, max_chars, credentials, verified_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.platform,
    input.label?.trim() || `${platformName(input.platform)} ${who.handle}`,
    who.handle,
    httpUrl(who.profileUrl),
    input.maxChars ?? null,
    seal(JSON.stringify(credentials)),
    ts,
    ts,
  );
  return getAccount(id);
}

export async function updateAccount(
  id: string,
  patch: { label?: string; maxChars?: number | null; credentials?: Record<string, unknown> },
): Promise<Account> {
  requireOwner("change accounts");
  const current = getAccount(id);
  if (patch.credentials) {
    const credentials = cleanCredentials(current.platform, patch.credentials);
    const who = await verify(current.platform, credentials);
    db.prepare("UPDATE accounts SET credentials = ?, handle = ?, profile_url = ?, last_error = NULL, verified_at = ? WHERE id = ?").run(
      seal(JSON.stringify(credentials)),
      who.handle,
      httpUrl(who.profileUrl),
      new Date().toISOString(),
      id,
    );
  }
  if (patch.label !== undefined) db.prepare("UPDATE accounts SET label = ? WHERE id = ?").run(patch.label.trim() || current.label, id);
  if (patch.maxChars !== undefined) db.prepare("UPDATE accounts SET max_chars = ? WHERE id = ?").run(patch.maxChars, id);
  return getAccount(id);
}

/** Re-check stored credentials (e.g. a token that may have expired). Records the outcome on the account. */
export async function recheckAccount(id: string): Promise<Account> {
  const account = getAccount(id);
  try {
    const who = await platform(account.platform).verify(accountCredentials(id));
    db.prepare("UPDATE accounts SET handle = ?, profile_url = ?, last_error = NULL, verified_at = ? WHERE id = ?").run(
      who.handle,
      httpUrl(who.profileUrl),
      new Date().toISOString(),
      id,
    );
  } catch (err) {
    setAccountError(id, err instanceof Error ? err.message : String(err));
  }
  return getAccount(id);
}

export function setAccountError(id: string, error: string | null): void {
  db.prepare("UPDATE accounts SET last_error = ? WHERE id = ?").run(error, id);
}

/**
 * Remove an account. Refused while it is a destination of posts that haven't gone out yet, because those posts
 * would silently lose it (and a post with no destinations falls back to the .env X / manual mode).
 */
export function deleteAccount(id: string): void {
  requireOwner("remove accounts");
  getAccount(id);
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM post_targets t JOIN posts p ON p.id = t.post_id
       WHERE t.account_id = ? AND t.status != 'published' AND p.status != 'published'`,
    )
    .get(id) as { n: number };
  if (pending.n) {
    throw new ConflictError(`${pending.n} draft, queued or unfinished post(s) still go to this account; remove it from them first.`);
  }
  // Published posts keep showing where they went: such an account is retired (credentials wiped), not deleted.
  const history = db.prepare("SELECT 1 FROM post_targets WHERE account_id = ? LIMIT 1").get(id);
  if (history) {
    db.prepare("UPDATE accounts SET removed_at = ?, credentials = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), seal("{}"), id);
  } else {
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  }
}


const DAY = 86_400_000;

/**
 * Re-check every account once a day so an expired token (Threads and LinkedIn tokens last about 60 days) shows up
 * as an account error, with a browser notification, before a scheduled post fails on it.
 */
export function startAccountChecks(onNewError: (account: Account) => void): () => void {
  const run = async () => {
    for (const a of listAccounts()) {
      if (a.verifiedAt && Date.now() - Date.parse(a.verifiedAt) < DAY - 60_000) continue;
      const checked = await recheckAccount(a.id);
      if (checked.lastError && checked.lastError !== a.lastError) onNewError(checked);
    }
  };
  const first = setTimeout(() => void run().catch((err) => console.error("[accounts] check failed:", err)), 60_000);
  const timer = setInterval(() => void run().catch((err) => console.error("[accounts] check failed:", err)), 3_600_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
