// SQLite via Node's built-in node:sqlite — no native build step, one file on disk.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env.ts";

mkdirSync(path.join(env.dataDir, "media"), { recursive: true });

export const db = new DatabaseSync(path.join(env.dataDir, "yaypost.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// Append-only list; index + 1 is the schema version stored in PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    title TEXT,
    status TEXT NOT NULL,
    thread TEXT NOT NULL,
    scheduled_at TEXT,
    published_at TEXT,
    error TEXT,
    x_post_ids TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX posts_status_time ON posts(status, scheduled_at);

  CREATE TABLE media (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    alt TEXT,
    path TEXT NOT NULL,
    x_media_id TEXT,
    x_media_expires_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT
  );

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT NOT NULL);

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    last_at TEXT
  );

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    label TEXT NOT NULL,
    handle TEXT,
    profile_url TEXT,
    max_chars INTEGER,
    credentials TEXT NOT NULL,
    last_error TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE post_targets (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    thread TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    external_ids TEXT NOT NULL DEFAULT '[]',
    url TEXT,
    error TEXT,
    published_at TEXT,
    PRIMARY KEY (post_id, account_id)
  );
  CREATE INDEX post_targets_account ON post_targets(account_id);
  `,
  `
  ALTER TABLE accounts ADD COLUMN removed_at TEXT;
  ALTER TABLE post_targets ADD COLUMN snapshot INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE post_targets ADD COLUMN metrics TEXT;
  `,
  `
  ALTER TABLE posts ADD COLUMN approval TEXT;
  ALTER TABLE posts ADD COLUMN approval_note TEXT;
  ALTER TABLE posts ADD COLUMN approval_by TEXT;
  ALTER TABLE posts ADD COLUMN approval_at TEXT;

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    post_id TEXT,
    detail TEXT
  );
  CREATE INDEX audit_post ON audit(post_id);

  -- Chat messages that carry an approval request, so a decision can update them everywhere.
  CREATE TABLE approval_messages (
    post_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    ref TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (channel, ref)
  );
  CREATE INDEX approval_messages_post ON approval_messages(post_id);

  CREATE TABLE operator_runs (
    id TEXT PRIMARY KEY,
    trigger TEXT NOT NULL,
    task TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    summary TEXT,
    error TEXT,
    tool_calls INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Approval chats became plugins: their state moved under the plugin's own store keys.
  `
  INSERT OR IGNORE INTO kv (key, value) SELECT 'plugin:telegram-approvals:offset', value FROM kv WHERE key = 'telegram.approval.offset';
  DELETE FROM kv WHERE key = 'telegram.approval.offset';
  `,
  // The person can make agents forget a note (Settings › Memory); the audit line itself stays.
  `
  ALTER TABLE audit ADD COLUMN forgotten_at TEXT;
  `,
  // Which AI each operator run used (the provider and model can change between runs).
  `
  ALTER TABLE operator_runs ADD COLUMN provider TEXT;
  ALTER TABLE operator_runs ADD COLUMN model TEXT;
  `,
  // Webhooks: pause one without deleting it, chat formats (Slack/Discord take text, not our JSON), and a delivery log.
  `
  ALTER TABLE webhooks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE webhooks ADD COLUMN format TEXT NOT NULL DEFAULT 'json';
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL,
    type TEXT NOT NULL,
    at TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 0,
    status INTEGER,
    error TEXT,
    response TEXT
  );
  CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, at);
  `,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let v = current; v < MIGRATIONS.length; v++) {
  db.exec("BEGIN");
  try {
    db.exec(MIGRATIONS[v]!);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const kv = {
  get<T>(key: string): T | undefined {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  },
  set(key: string, value: unknown) {
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      JSON.stringify(value),
    );
  },
};
