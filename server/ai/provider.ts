// The operator's model, through the official Anthropic SDK: which provider and model, whether a key is set, model capabilities.
// Providers: Anthropic (Claude) or Z.ai (GLM, through its Anthropic-compatible Messages endpoint).
// Keys come from .env (read at startup). The model can be switched at runtime from Settings; that choice is stored in
// the database and wins over AI_PROVIDER / AI_MODEL until it is reset.
import Anthropic from "@anthropic-ai/sdk";
import { kv } from "../db.ts";
import { env } from "../env.ts";

const ZAI_BASE_URL = "https://api.z.ai/api/anthropic";
const CHOICE_KEY = "ai.model";

export type ProviderId = "anthropic" | "zai";

/** Models offered in Settings, best first. Any other model id still works through PUT /api/operator/model or AI_MODEL. */
export const PROVIDERS: { id: ProviderId; name: string; models: string[] }[] = [
  { id: "anthropic", name: "Anthropic", models: ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  { id: "zai", name: "Z.ai", models: ["glm-5.3-flash", "glm-5.3-flashx", "glm-5.3"] },
];

type Provider = { kind: ProviderId; model: string } | { kind: "none"; reason: string };

const keys: Record<ProviderId, string | undefined> = {
  anthropic: env.ai.anthropicKey ?? (process.env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined),
  zai: env.ai.zaiKey,
};

/** What .env says: AI_PROVIDER / AI_MODEL, or whichever key is present (Anthropic first). */
function envProvider(): Provider {
  const choice = env.ai.provider ?? (keys.anthropic ? "anthropic" : keys.zai ? "zai" : undefined);
  if (choice === "zai") {
    if (!keys.zai) return { kind: "none", reason: "AI_PROVIDER=zai but no ZAI_API_KEY in .env; set it, then restart." };
    return { kind: "zai", model: env.ai.model ?? "glm-5.3-flash" };
  }
  if (choice === "anthropic") {
    if (!keys.anthropic) return { kind: "none", reason: "No Claude API key: set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in .env, then restart." };
    return { kind: "anthropic", model: env.ai.model ?? "claude-opus-5-5" };
  }
  if (choice) return { kind: "none", reason: `Unknown AI_PROVIDER "${choice}": use anthropic or zai.` };
  return { kind: "none", reason: "No AI API key: set ANTHROPIC_API_KEY (Claude) or ZAI_API_KEY (GLM) in .env, then restart." };
}

const fromEnv = envProvider();

/** The choice made in Settings, if its provider still has a key; otherwise .env decides. */
function current(): Provider {
  const choice = kv.get<{ provider: ProviderId; model: string }>(CHOICE_KEY);
  return choice && keys[choice.provider] ? { kind: choice.provider, model: choice.model } : fromEnv;
}

export function aiStatus(): { configured: boolean; provider: string | null; model: string | null } {
  const p = current();
  return p.kind === "none" ? { configured: false, provider: null, model: null } : { configured: true, provider: p.kind, model: p.model };
}

/** Why the AI can't be used, or null when a provider is configured. */
export function aiUnavailableReason(): string | null {
  const p = current();
  return p.kind === "none" ? p.reason : null;
}

/** Whether the provider is Anthropic itself (Anthropic-only features: Models API, effort, server-side fallbacks, auto-caching). */
export function isAnthropic(): boolean {
  return current().kind === "anthropic";
}

/** For Settings: the providers (with whether their key is set), the .env default and whether a choice overrides it. */
export function aiChoices() {
  const d = fromEnv.kind === "none" ? null : { provider: fromEnv.kind, model: fromEnv.model };
  const now = aiStatus();
  return {
    providers: PROVIDERS.map((p) => ({ ...p, configured: Boolean(keys[p.id]) })),
    default: d,
    overridden: now.provider !== (d?.provider ?? null) || now.model !== (d?.model ?? null),
  };
}

/** Switch the model (null: back to .env). Throws AiError when that provider has no key. */
export function setAiChoice(choice: { provider: ProviderId; model: string } | null): void {
  if (choice && !keys[choice.provider]) {
    throw new AiError("ai_not_configured", `No ${choice.provider === "zai" ? "ZAI_API_KEY" : "ANTHROPIC_API_KEY"} in .env, so ${choice.provider === "zai" ? "Z.ai" : "Anthropic"} can't be used.`);
  }
  kv.set(CHOICE_KEY, choice);
}

export class AiError extends Error {
  constructor(
    readonly code: "ai_not_configured" | "ai_error",
    message: string,
  ) {
    super(message);
  }
}

// ---------- Claude (Anthropic SDK) ----------

const effortSupport = new Map<string, Promise<boolean>>();

/**
 * Older models (e.g. claude-haiku-4-5, claude-sonnet-4-5) reject `effort`, so ask the Models API once per model.
 * If it can't answer, assume a current model, and ask again in 5 minutes (never, if the endpoint said 404).
 */
function supportsLowEffort(c: Anthropic, model: string): Promise<boolean> {
  let answer = effortSupport.get(model);
  if (!answer) {
    answer = c.models.retrieve(model, {}, { timeout: 10_000, maxRetries: 0 }).then(
      (m) => (m.capabilities?.effort ? m.capabilities.effort.supported && m.capabilities.effort.low.supported : true),
      (err) => {
        if (!(err instanceof Anthropic.NotFoundError)) setTimeout(() => effortSupport.delete(model), 300_000).unref();
        return true;
      },
    );
    effortSupport.set(model, answer);
  }
  return answer;
}

/** A Messages API client for other features (the operator), credentials from the environment. Throws AiError without a key. */
export function createClaudeClient(options: ConstructorParameters<typeof Anthropic>[0] = {}): Anthropic {
  const p = current();
  if (p.kind === "none") throw new AiError("ai_not_configured", p.reason);
  if (p.kind === "zai") return new Anthropic({ ...options, baseURL: ZAI_BASE_URL, apiKey: null, authToken: keys.zai! });
  return new Anthropic(options); // reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN itself
}

/** Whether the configured model accepts `output_config.effort` (asked once per model via the Models API; Anthropic only). */
export function modelSupportsEffort(c: Anthropic): Promise<boolean> {
  const p = current();
  if (p.kind !== "anthropic") return Promise.resolve(false);
  return supportsLowEffort(c, p.model);
}
