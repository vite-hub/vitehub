import { resolve } from "node:path";

import { envSchema, hubEnv } from "@vite-hub/env/vite";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  appType: "custom",
  build: {
    outDir: mode === "client" ? "dist/client" : "dist/server",
    ssr: mode !== "client",
    rolldownOptions: {
      input: resolve(import.meta.dirname, mode === "client" ? "index.html" : "src/server.ts"),
    },
  },
  plugins: [hubEnv()],
  env: envSchema(new URL("./.env.example", import.meta.url)),
}));
