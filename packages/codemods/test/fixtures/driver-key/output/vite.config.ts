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
          images: { driver: "cloudflare", bucketName: "images" },
          reports: { driver: "vercel", access: "private" },
          scratch: { driver: "fs" },
        },
      },
      cache: { driver: "vercel" },
      database: { driver: "cloudflare" },
      email: { driver: "cloudflare" },
      kv: { driver: process.env.KV_DRIVER },
      rateLimit: { driver: "memory" },
      realtime: { driver: "memory" },
      workflow: { driver: "openworkflow", sqlite: { path: ".data/workflow.sqlite" } },
      workspace: { store: { driver: "vercel" } },
    }),
    hubQueue({ driver: provider }),
    hubSandboxTask({ driver: "vercel" }),
  ],
})
