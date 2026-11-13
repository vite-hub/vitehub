import { defineConfig } from "vite"
import { hubDb } from "@vite-hub/database/vite"

export default defineConfig(async () => {
  const [{ hubBlob }, { hubKv }] = await Promise.all([
    import("@vite-hub/blob/vite"),
    import("@vite-hub/kv/vite"),
  ])
  return {
    plugins: [hubBlob(), hubKv({ driver: "fs-lite" }), hubDb()],
  }
})
