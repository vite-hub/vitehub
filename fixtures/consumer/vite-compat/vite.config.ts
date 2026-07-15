import { defineConfig } from "vite"
import { vitehub } from "@vite-hub/vite"

export default defineConfig({
  plugins: [vitehub({ auth: true })],
})
