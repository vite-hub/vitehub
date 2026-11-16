import { defineConfig } from "vite"
import { hubDatabase } from "@vite-hub/database/vite"

export default defineConfig(async () => {
  const [{ hubBlob }, { hubKV }] = await Promise.all([
    import("@vite-hub/blob/vite"),
    import("@vite-hub/kv/vite"),
  ])
  return {
    plugins: [hubBlob(), hubKV({ driver: "fs-lite" }), hubDatabase()],
  }
})
