import { hubChat } from "@vitehub/chat/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubChat({
      cloudflare: {
        durableObjectState: true,
      },
    }),
    ...nitro({
      preset: "cloudflare_module",
    }),
  ],
})
