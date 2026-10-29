import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

// The Console serves the operation RPC without sign-in, and NODE_ENV=development gives it the local identity.
export default defineConfig({
  plugins: [vitehub({ console: { auth: false }, preset: "node" }), nitro()],
})
