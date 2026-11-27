import ui from "@vite-hub/ui/vite"
import vue from "@vitejs/plugin-vue"
import { resolve } from "node:path"
import { defineConfig } from "vite"

import { channelSimulatorPages } from "./channels-fixture.ts"
import { consoleMockAPI } from "./mock-api.ts"
import { consoleMockRPC } from "./rpc.ts"
import { consoleMockSite } from "./site-fixture.ts"
import { consoleAppConfig } from "../../packages/vite-hub/src/console/app.config.ts"

const workspaceRoot = resolve(import.meta.dirname, "../..")

export default defineConfig({
  appType: "spa",
  base: "/_vitehub/",
  plugins: [
    consoleMockAPI(),
    consoleMockRPC(),
    consoleMockSite(),
    channelSimulatorPages(),
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        colorMode: false,
        dts: false,
        ui: consoleAppConfig,
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: "@vite-hub/kit/styles/tailwind.css",
        replacement: resolve(workspaceRoot, "packages/kit/src/styles/tailwind.css"),
      },
      {
        find: "@vite-hub/ui/styles.css",
        replacement: resolve(workspaceRoot, "packages/ui/styles.css"),
      },
      {
        find: /^@vite-hub\/ui\/primitive-rail$/,
        replacement: resolve(workspaceRoot, "packages/ui/src/primitive-rail.ts"),
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
        find: "@vite-hub/auth/vue",
        replacement: resolve(workspaceRoot, "packages/auth/src/vue.ts"),
      },
      {
        find: "@vite-hub/content/editor",
        replacement: resolve(workspaceRoot, "packages/content/src/editor.ts"),
      },
      {
        find: "@vite-hub/realtime/vue",
        replacement: resolve(workspaceRoot, "packages/realtime/src/vue.ts"),
      },
      {
        find: /^@vite-hub\/comments\/client$/,
        replacement: resolve(workspaceRoot, "packages/comments/src/client.ts"),
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
