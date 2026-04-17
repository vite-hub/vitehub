import { defineConfig } from "vite"
import { hubKv } from "@vitehub/kv/vite"

export default defineConfig({
  plugins: [hubKv()],
  server: {
    port: 5173,
  },
})
