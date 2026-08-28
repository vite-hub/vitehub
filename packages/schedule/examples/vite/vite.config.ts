import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubSchedule } from "@vite-hub/schedule/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubSchedule()],
})
