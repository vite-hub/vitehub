import { hubKv } from "../../src/vite.ts"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubKv()],
})
