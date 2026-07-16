import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

export default defineConfig({
  env: {
    server: {
      GH_TOKEN: env(),
    },
  },
  plugins: [vitehub()],
})
