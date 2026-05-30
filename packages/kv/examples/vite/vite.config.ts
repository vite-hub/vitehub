import { defineConfig } from "vite"
import { hubKv } from "@vite-hub/kv/vite"

export default defineConfig({
  plugins: [hubKv()],
  server: {
    port: 5173,
  },
})
