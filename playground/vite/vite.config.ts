import { resolve } from "node:path"

import { defineConfig } from "vite"

const VITEHUB_MODES = {
  e2e: "e2e",
  blob: "blob",
  chat: "chat",
  db: "db",
  env: "env",
  kv: "kv",
  queue: "queue",
  schedule: "schedule",
  sandbox: "sandbox",
  workspace: "workspace",
  workflow: "workflow",
} as const

type ViteHubMode = typeof VITEHUB_MODES[keyof typeof VITEHUB_MODES]

function isViteCli(argv: string[]): boolean {
  return argv.some(arg => /(?:^|[/\\])vite(?:\.[cm]?js)?$/.test(arg) || arg === "vite")
}

function getViteCliMode(argv: string[] = process.argv): ViteHubMode | undefined {
  if (!isViteCli(argv)) {
    return undefined
  }

  const modes = new Set<string>(Object.values(VITEHUB_MODES))
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const mode = arg === "--mode" || arg === "-m"
      ? argv[index + 1]
      : arg.startsWith("--mode=")
        ? arg.slice("--mode=".length)
        : undefined
    if (mode && modes.has(mode)) {
      return mode as ViteHubMode
    }
  }
}

function getViteMode(): ViteHubMode | undefined {
  const mode = process.env.VITEHUB_VITE_MODE
  return Object.values(VITEHUB_MODES).includes(mode as ViteHubMode)
    ? mode as ViteHubMode
    : getViteCliMode()
}

const buildMode: ViteHubMode = getViteMode() || VITEHUB_MODES.queue

const inputByMode: Record<ViteHubMode, string> = {
  e2e: "src/server.e2e.ts",
  blob: "src/server.blob.ts",
  chat: "src/server-chat.ts",
  db: "src/server.db.ts",
  env: "src/server-env.ts",
  kv: "src/server.ts",
  queue: "src/server.ts",
  schedule: "src/daily-marker.schedule.ts",
  sandbox: "src/server.ts",
  workspace: "src/server-workspace.ts",
  workflow: "src/server-workflow.ts",
}
const input = inputByMode[buildMode]

export default defineConfig(async () => {
  const hosting = process.env.VITEHUB_HOSTING || ""
  const baseConfig = {
    appType: "custom" as const,
    build: {
      outDir: "dist/client",
      rollupOptions: {
        external: ["askweb"],
        input: resolve(import.meta.dirname, input),
      },
    },
  }

  if (buildMode === VITEHUB_MODES.e2e) {
    const [{ hubBlob }, { hubDb }, { hubKv }, { hubQueue }, { hubSchedule }, { hubSandbox }, { hubWorkspace }, { hubWorkflow }] = await Promise.all([
      import("@vite-hub/blob/vite"),
      import("@vite-hub/database/vite"),
      import("@vite-hub/kv/vite"),
      import("@vite-hub/queue/vite"),
      import("@vite-hub/schedule/vite"),
      import("@vite-hub/sandbox/vite"),
      import("@vite-hub/workspace/vite"),
      import("@vite-hub/workflow/vite"),
    ])
    const { createViteE2EComposer, resolveViteE2EOptions } = await import("./build/vite-e2e")
    const composerOptions = resolveViteE2EOptions(import.meta.dirname, hosting)

    return {
      ...baseConfig,
      build: {
        ...baseConfig.build,
        rollupOptions: {
          ...baseConfig.build.rollupOptions,
          external: [
            "@cloudflare/sandbox",
            "askweb",
            "cloudflare:workers",
            "workflow",
            "workflow/api",
            "workflow/runtime",
          ],
        },
        ssr: true,
      },
      blob: composerOptions.hosting.includes("vercel")
        ? { access: "private", driver: "vercel-blob" }
        : {},
      kv: {},
      plugins: [
        hubQueue(),
        hubSchedule(),
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
    const { hubBlob } = await import("@vite-hub/blob/vite")
    return {
      ...baseConfig,
      blob: {},
      plugins: [hubBlob()],
    }
  }

  if (buildMode === VITEHUB_MODES.chat) {
    const { hubAgent } = await import("@vite-hub/agent/vite")
    return {
      ...baseConfig,
      agent: true,
      plugins: [hubAgent()],
    }
  }

  if (buildMode === VITEHUB_MODES.env) {
    const { env, hubEnv } = await import("@vite-hub/env/vite")
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
      plugins: [hubEnv()],
    }
  }

  if (buildMode === VITEHUB_MODES.workflow) {
    const [{ hubMarkdownTemplate }, { hubWorkflow }] = await Promise.all([
      import("@vite-hub/markdown-template/vite"),
      import("@vite-hub/workflow/vite"),
    ])
    return {
      ...baseConfig,
      plugins: [hubMarkdownTemplate(), hubWorkflow()],
      workflow: {},
    }
  }

  if (buildMode === VITEHUB_MODES.schedule) {
    const [{ hubKv }, { hubSchedule }] = await Promise.all([
      import("@vite-hub/kv/vite"),
      import("@vite-hub/schedule/vite"),
    ])
    return {
      ...baseConfig,
      build: {
        ...baseConfig.build,
        ssr: true,
      },
      kv: {},
      plugins: [hubSchedule(), hubKv()],
    }
  }

  if (buildMode === VITEHUB_MODES.workspace) {
    const { hubWorkspace } = await import("@vite-hub/workspace/vite")
    return {
      ...baseConfig,
      plugins: [hubWorkspace()],
      workspace: {},
    }
  }

  if (buildMode === VITEHUB_MODES.db) {
    const { hubDb } = await import("@vite-hub/database/vite")
    return {
      ...baseConfig,
      plugins: [hubDb()],
    }
  }

  const [{ hubKv }, { hubQueue }] = await Promise.all([
    import("@vite-hub/kv/vite"),
    import("@vite-hub/queue/vite"),
  ])

  return {
    ...baseConfig,
    plugins: [hubQueue(), hubKv()],
    kv: {},
    queue: {},
  }
})
