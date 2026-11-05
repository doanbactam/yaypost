// Gives a test file its own data folder and config before any server module is imported (server/db.ts opens the
// database on import). Call it first, then import server modules dynamically.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

export function useTempServer(env: Record<string, string> = {}): void {
  const dir = mkdtempSync(path.join(tmpdir(), "yaypost-test-"));
  for (const k of ["AUTH_TOKEN", "AGENT_TOKEN", "PUBLIC_URL"]) delete process.env[k];
  Object.assign(process.env, env, { DATA_DIR: dir, CONFIG_PATH: path.join(dir, "yaypost.config.json") });
  const config = { timezone: "UTC", approval: { require: "agents", except: [] }, plugins: { load: [path.join(import.meta.dirname, "fixtures", "fake-platform")] } };
  writeFileSync(process.env.CONFIG_PATH!, JSON.stringify(config));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}

/** An ISO time `minutes` from now. */
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
