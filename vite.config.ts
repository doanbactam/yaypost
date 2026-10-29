import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API server reads PORT from .env itself; read the same file here so the dev proxy targets that port.
const envFile = fileURLToPath(new URL(".env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const api = `http://127.0.0.1:${process.env.PORT?.trim() || 3000}`;

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/api", "/mcp", "/media", "/openapi.json", "/docs", "/llms.txt", "/llms-full.txt"].map((p) => [p, { target: api, changeOrigin: true }]),
    ),
  },
});
