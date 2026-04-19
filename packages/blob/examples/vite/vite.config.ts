import { defineConfig } from "vite"
import { hubBlob } from "@vitehub/blob/vite"

export default defineConfig({
  blob: { driver: "vercel-blob" },
  plugins: [hubBlob()],
  server: { port: 5173 },
})
