import { chatDevtools } from "@vitehub/chat/vite"
import { DevTools } from "@vitejs/devtools"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    DevTools(),
    chatDevtools(),
    nitro({
      modules: ["@vitehub/chat/nitro"],
      preset: "cloudflare_module",
    }),
  ],
})
