import { hubChat } from "@vitehub/chat/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubChat(),
    ...nitro({
      preset: "cloudflare_module",
    }),
  ],
})
