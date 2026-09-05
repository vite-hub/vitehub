import ui from "@vite-hub/ui/vite"
import vue from "@vitejs/plugin-vue"
import { resolve } from "node:path"
import { defineConfig } from "vite"

import { consoleMockAPI } from "./mock-api.ts"
import { consoleAppConfig } from "../../packages/vite-hub/src/console/app.config.ts"

const workspaceRoot = resolve(import.meta.dirname, "../..")

export default defineConfig({
  appType: "spa",
  base: "/_vitehub/",
  plugins: [
    consoleMockAPI(),
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        dts: false,
        ui: consoleAppConfig,
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: "devframe/client",
        replacement: resolve(import.meta.dirname, "mock-rpc.ts"),
      },
      {
        find: "@vite-hub/ui/styles.css",
        replacement: resolve(workspaceRoot, "packages/ui/styles.css"),
      },
      {
        find: /^@vite-hub\/ui$/,
        replacement: resolve(workspaceRoot, "packages/ui/src/index.ts"),
      },
      {
        find: "vite-hub/agent/vue",
        replacement: resolve(workspaceRoot, "packages/agent/src/vue.ts"),
      },
      {
        find: "vite-hub/source/client",
        replacement: resolve(workspaceRoot, "packages/source/src/client.ts"),
      },
    ],
    dedupe: ["vue", "vue-router"],
  },
  root: import.meta.dirname,
  server: {
    allowedHosts: true,
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
})
