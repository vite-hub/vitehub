import { defineConfig } from "vite"
import { hubBlob } from "../../src/vite.ts"

export default defineConfig({
  plugins: [hubBlob()],
})
