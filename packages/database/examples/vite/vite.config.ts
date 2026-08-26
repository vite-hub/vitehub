import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubDb } from "@vite-hub/database/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubDb()],
})
