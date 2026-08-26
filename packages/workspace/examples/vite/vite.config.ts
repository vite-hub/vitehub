import { resolve } from "node:path"
import { defineConfig } from "vite"
import { hubWorkspace } from "@vite-hub/workspace/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubWorkspace()],
  workspace: {},
})
