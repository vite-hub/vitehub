import { resolve } from "node:path"

import { env, hubEnv } from "@vite-hub/env/vite"
import { defineConfig } from "vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubEnv({ prefix: "VITEHUB_" })],
  env: {
    define: {
      __APP_VERSION__: env({
        mode: "build",
        source: env.packageJson("version"),
      }),
    },
    public: {
      appName: env({
        default: "ViteHub Env",
        mode: "build",
      }),
    },
    server: {
      github: {
        token: env({ secret: true, source: env.source("GITHUB_TOKEN") }),
      },
    },
  },
})
