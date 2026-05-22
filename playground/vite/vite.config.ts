import { resolve } from "node:path"

import { getViteMode, VITEHUB_MODES, type ViteHubMode } from "@vitehub/internal/build/mode"
import { defineConfig } from "vite"
import { createViteE2EComposer, resolveViteE2EOptions } from "./build/vite-e2e"

const buildMode: ViteHubMode = getViteMode() || VITEHUB_MODES.queue

const inputByMode: Record<ViteHubMode, string> = {
  e2e: "src/server.e2e.ts",
  blob: "src/server.blob.ts",
  chat: "src/server-chat.ts",
  db: "src/server.db.ts",
  env: "src/server-env.ts",
  kv: "src/server.ts",
  queue: "src/server.ts",
  sandbox: "src/server.ts",
  workspace: "src/server-workspace.ts",
  workflow: "src/server-workflow.ts",
}
const input = inputByMode[buildMode]

const dbConfig = {
  connection: {
    authToken: process.env.TURSO_AUTH_TOKEN,
    url: process.env.TURSO_DATABASE_URL,
  },
  databases: {
    analytics: {
      connection: {
        authToken: process.env.TURSO_AUTH_TOKEN,
        url: process.env.TURSO_ANALYTICS_DATABASE_URL || process.env.TURSO_DATABASE_URL,
      },
      cloudflare: {
        binding: "DB_ANALYTICS",
        databaseName: process.env.VITEHUB_D1_ANALYTICS_DATABASE_NAME || "vitehub-playground-analytics",
        databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
        previewDatabaseId: process.env.VITEHUB_D1_ANALYTICS_PREVIEW_DATABASE_ID,
      },
    },
  },
  cloudflare: {
    binding: "DB",
    databaseName: process.env.VITEHUB_D1_DATABASE_NAME || "vitehub-playground-db",
    databaseId: process.env.VITEHUB_D1_DATABASE_ID,
    previewDatabaseId: process.env.VITEHUB_D1_PREVIEW_DATABASE_ID,
  },
}

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

  if (buildMode === VITEHUB_MODES.e2e) {
    const [{ hubBlob }, { hubDb }, { hubKv }, { hubQueue }, { hubSandbox }, { hubWorkspace }, { hubWorkflow }] = await Promise.all([
      import("@vitehub/blob/vite"),
      import("@vitehub/db/vite"),
      import("@vitehub/kv/vite"),
      import("@vitehub/queue/vite"),
      import("@vitehub/sandbox/vite"),
      import("@vitehub/workspace/vite"),
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
      db: dbConfig,
      kv: {},
      plugins: [
        hubQueue(),
        hubKv(),
        hubWorkflow(),
        hubBlob(),
        hubDb(),
        hubSandbox(),
        hubWorkspace(),
        createViteE2EComposer({
          ...composerOptions,
          clientOutDir: "dist/client",
          rootDir: import.meta.dirname,
          workspace: composerOptions.workspace,
        }),
      ],
      queue: {},
      sandbox: composerOptions.sandbox,
      workspace: { store: { provider: "memory" } },
      workflow: {},
    }
  }

  if (buildMode === VITEHUB_MODES.blob) {
    const { hubBlob } = await import("@vitehub/blob/vite")
    return {
      ...baseConfig,
      blob: {},
      plugins: [hubBlob()],
    }
  }

  if (buildMode === VITEHUB_MODES.chat) {
    const { hubChat } = await import("@vitehub/agent/chat/vite")
    const { hubDevtools } = await import("@vitehub/devtools")
    return {
      ...baseConfig,
      chat: {
        cloudflare: { durableObjectState: false },
        dev: { initialize: false },
        provider: "nitro",
        webhook: false,
      },
      plugins: [hubDevtools(), hubChat()],
    }
  }

  if (buildMode === VITEHUB_MODES.env) {
    const { env, envVite } = await import("@vitehub/env/vite")
    return {
      ...baseConfig,
      env: {
        define: {
          __VITEHUB_PLAYGROUND_ENV__: env({ default: "enabled", mode: "build" }),
        },
        public: {
          appName: env({ default: "Vite playground", mode: "build" }),
        },
      },
      plugins: [envVite()],
    }
  }

  if (buildMode === VITEHUB_MODES.workflow) {
    const { hubWorkflow } = await import("@vitehub/workflow/vite")
    return {
      ...baseConfig,
      plugins: [hubWorkflow()],
      workflow: {},
    }
  }

  if (buildMode === VITEHUB_MODES.workspace) {
    const { hubWorkspace } = await import("@vitehub/workspace/vite")
    return {
      ...baseConfig,
      plugins: [hubWorkspace()],
      workspace: {},
    }
  }

  if (buildMode === VITEHUB_MODES.db) {
    const { hubDb } = await import("@vitehub/db/vite")
    return {
      ...baseConfig,
      db: dbConfig,
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
