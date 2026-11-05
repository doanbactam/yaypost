// Tests run in Node against the server code; vite.config.ts is the web UI's (root "web") and isn't used here.
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
