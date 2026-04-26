import { resolve } from "node:path"

import { defineConfig } from "vite"

const buildMode = process.env.VITEHUB_VITE_MODE || "queue"
const blobOnly = buildMode === "blob"
const workflowOnly = buildMode === "workflow"
const input = blobOnly ? "src/server.blob.ts" : "src/server.ts"

export default defineConfig(async () => {
  const baseConfig = {
    appType: "custom" as const,
    build: {
      outDir: "dist/client",
      rollupOptions: {
        input: resolve(import.meta.dirname, input),
      },
    },
  }

  if (blobOnly) {
    const { hubBlob } = await import("@vitehub/blob/vite")
    return {
      ...baseConfig,
      blob: {},
      plugins: [hubBlob()],
    }
  }

  if (workflowOnly) {
    const { hubWorkflow } = await import("@vitehub/workflow/vite")
    return {
      ...baseConfig,
      plugins: [hubWorkflow()],
      workflow: {},
    }
  }

  const [{ hubKv }, { hubQueue }] = await Promise.all([
    import("@vitehub/kv/vite"),
    import("@vitehub/queue/vite"),
  ])

  return {
    ...baseConfig,
    plugins: [hubQueue(), hubKv()],
    queue: {},
  }
})
