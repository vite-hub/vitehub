import { resolve } from "node:path"

import { getViteMode, VITEHUB_MODES } from "@vitehub/internal/build/mode"
import { defineConfig } from "vite"
import { createViteE2EComposer, resolveViteE2EOptions } from "./build/vite-e2e"

const buildMode = getViteMode() || VITEHUB_MODES.queue
const e2eMode = buildMode === VITEHUB_MODES.e2e
const blobOnly = buildMode === VITEHUB_MODES.blob
const dbOnly = buildMode === VITEHUB_MODES.db
const workflowOnly = buildMode === VITEHUB_MODES.workflow
const input = e2eMode
  ? "src/server.e2e.ts"
  : blobOnly
  ? "src/server.blob.ts"
  : dbOnly
    ? "src/server.db.ts"
  : workflowOnly
    ? "src/server-workflow.ts"
    : "src/server.ts"

export default defineConfig(async () => {
  const hosting = process.env.VITEHUB_HOSTING || ""
  const baseConfig = {
    appType: "custom" as const,
    build: {
      outDir: "dist/client",
      rollupOptions: {
        input: resolve(import.meta.dirname, input),
      },
    },
  }

  if (e2eMode) {
    const [{ hubBlob }, { hubDb }, { hubKv }, { hubQueue }, { hubSandbox }, { hubWorkflow }] = await Promise.all([
      import("@vitehub/blob/vite"),
      import("@vitehub/db/vite"),
      import("@vitehub/kv/vite"),
      import("@vitehub/queue/vite"),
      import("@vitehub/sandbox/vite"),
      import("@vitehub/workflow/vite"),
    ])
    const composerOptions = resolveViteE2EOptions(import.meta.dirname, hosting)

    return {
      ...baseConfig,
      build: {
        ...baseConfig.build,
        rollupOptions: {
          ...baseConfig.build.rollupOptions,
          external: [
            "@cloudflare/sandbox",
            "cloudflare:workers",
            "workflow",
            "workflow/api",
            "workflow/runtime",
          ],
        },
        ssr: true,
      },
      blob: {},
      db: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_DATABASE_URL,
        },
      },
      kv: {},
      plugins: [
        hubQueue(),
        hubKv(),
        hubWorkflow(),
        hubBlob(),
        hubDb(),
        hubSandbox(),
        createViteE2EComposer({
          ...composerOptions,
          clientOutDir: "dist/client",
          hosting,
          rootDir: import.meta.dirname,
        }),
      ],
      queue: {},
      sandbox: composerOptions.sandbox,
      workflow: {},
    }
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
    kv: {},
    queue: {},
  }
})
