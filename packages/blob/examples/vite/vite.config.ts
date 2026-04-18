import { defineConfig } from "vite"
import { hubBlob } from "@vitehub/blob/vite"

export default defineConfig({
  plugins: [hubBlob()],
  server: {
    port: 5173,
  },
})
