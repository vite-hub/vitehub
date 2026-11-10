import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

// The Console is a ViteHub app: Auth signs people in, and the Database keeps the linked projects.
export default defineConfig({
  plugins: [vitehub({ auth: true, database: true }), nitro()],
})
