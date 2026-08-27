import { resolve } from "node:path"

import { hubAgent } from "@vite-hub/agent/vite"
import { defineConfig } from "vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
  },
  plugins: [hubAgent()],
  ssr: {
    external: ["@vite-hub/agent"],
  },
})
