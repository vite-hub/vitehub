import { hubChat } from "@vitehub/chat/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubChat({
      cloudflare: {
        durableObjectState: {
          binding: "CHAT_STATE",
          className: "ChatStateDO",
          migrationTag: "v1",
        },
      },
      entry: "server/chat.ts",
      route: "/api/webhooks/[platform]",
    }),
    ...nitro({
      preset: "cloudflare_module",
    }),
  ],
})
