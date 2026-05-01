import { resolve } from "node:path"
import { defineConfig } from "vite"
import { hubWorkspace } from "@vitehub/workspace/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubWorkspace()],
  workspace: {},
})
