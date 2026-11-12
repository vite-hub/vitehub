import { hubQueue } from "@vite-hub/queue/vite"
import { hubSandboxTask } from "@vite-hub/sandbox/task/vite"
import { vitehub } from "vite-hub"
import { defineConfig } from "vite"

const provider = process.env.QUEUE_PROVIDER === "vercel" ? "vercel" : "cloudflare"

export default defineConfig({
  plugins: [
    vitehub({
      blob: {
        stores: {
          images: { driver: "cloudflare-r2", bucketName: "images" },
          reports: { driver: "vercel-blob", access: "private" },
          scratch: { driver: "fs" },
        },
      },
      cache: { driver: "vercel-runtime-cache" },
      database: { driver: "d1" },
      email: { driver: "cloudflare-email" },
      kv: { driver: process.env.KV_DRIVER },
      rateLimit: { provider: "memory" },
      realtime: { authority: "memory" },
      workflow: { provider: "openworkflow", sqlite: { path: ".data/workflow.sqlite" } },
      workspace: { store: { provider: "vercel-blob" } },
    }),
    hubQueue({ provider }),
    hubSandboxTask({ provider: "vercel" }),
  ],
})
