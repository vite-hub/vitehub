import { hubChat } from "@vitehub/chat/vite"
import { DevTools } from "@vitejs/devtools"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    DevTools(),
    hubChat(),
    nitro({
      modules: ["@vitehub/chat/nitro"],
      preset: "cloudflare_module",
    }),
  ],
})
