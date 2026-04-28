import { resolve } from "node:path"

import { getViteMode, VITEHUB_MODES } from "@vitehub/internal/build/mode"
import { defineConfig } from "vite"

const buildMode = getViteMode() || VITEHUB_MODES.queue
const blobOnly = buildMode === VITEHUB_MODES.blob
const dbOnly = buildMode === VITEHUB_MODES.db
const workflowOnly = buildMode === VITEHUB_MODES.workflow
const input = blobOnly
  ? "src/server.blob.ts"
  : dbOnly
    ? "src/server.db.ts"
  : workflowOnly
    ? "src/server-workflow.ts"
    : "src/server.ts"

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

  if (dbOnly) {
    const { hubDb } = await import("@vitehub/db/vite")
    return {
      ...baseConfig,
      db: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_DATABASE_URL,
        },
      },
      plugins: [hubDb()],
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
