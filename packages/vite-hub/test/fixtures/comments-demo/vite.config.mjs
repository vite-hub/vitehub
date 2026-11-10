import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

// `vite dev` serves the Console without sign-in, with the local identity. A production build refuses `auth: false`.
export default defineConfig({
  plugins: [vitehub({ console: { auth: false }, preset: "node" }), nitro()],
})
