import { resolve } from "node:path"

import { defineConfig } from "vite"

import { hubBlob } from "@vite-hub/blob/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubBlob()],
  blob: {},
})
