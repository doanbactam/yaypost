// Environment (.env) — secrets and process settings. Scheduling rules live in yaypost.config.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const str = (k: string) => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};

export const env = {
  port: Number(str("PORT") ?? 3000),
  host: str("HOST") ?? "127.0.0.1",
  production: process.env.NODE_ENV === "production",
  dataDir: path.resolve(ROOT, str("DATA_DIR") ?? "data"),
  configPath: path.resolve(ROOT, str("CONFIG_PATH") ?? "yaypost.config.json"),
  /** Public base URL, used in links sent to webhooks/agents/notifications. */
  publicUrl: str("PUBLIC_URL"),
  /** When set, every /api, /mcp and /media request needs `Authorization: Bearer <token>`. */
  authToken: str("AUTH_TOKEN"),
  /**
   * Token to give agents instead of AUTH_TOKEN: same API, but it can't approve posts, resume publishing or touch
   * accounts. Requires AUTH_TOKEN (otherwise a request without a token would be treated as the owner).
   */
  agentToken: str("AGENT_TOKEN"),
  /** Extra hostnames accepted in the Host header when no AUTH_TOKEN is set (comma-separated). */
  allowedHosts: (str("ALLOWED_HOSTS") ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),

  ai: {
    /** "anthropic" or "zai"; when unset, whichever key is present (Anthropic first). */
    provider: str("AI_PROVIDER")?.toLowerCase(),
    model: str("AI_MODEL"),
    anthropicKey: str("ANTHROPIC_API_KEY"),
    zaiKey: str("ZAI_API_KEY"),
  },

  vapidSubject: str("VAPID_SUBJECT") ?? "mailto:yaypost@localhost",
};

if (env.publicUrl) {
  let ok = false;
  try {
    ok = /^https?:$/.test(new URL(env.publicUrl).protocol);
  } catch {
    // reported below
  }
  if (!ok) throw new Error(`PUBLIC_URL must be a full http(s) URL such as https://threads.example.com (got "${env.publicUrl}")`);
  env.publicUrl = env.publicUrl.replace(/\/+$/, "");
}

if (env.agentToken && !env.authToken) {
  throw new Error("AGENT_TOKEN needs AUTH_TOKEN too: without it, a request with no token would act as the owner and could approve its own posts.");
}
if (env.agentToken && env.agentToken === env.authToken) throw new Error("AGENT_TOKEN must differ from AUTH_TOKEN.");

export function publicUrl(): string {
  return env.publicUrl ?? `http://${env.host === "0.0.0.0" ? "localhost" : env.host}:${env.port}`;
}
