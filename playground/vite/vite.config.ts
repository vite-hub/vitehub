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
      import("../../packages/blob/src/vite.ts"),
      import("../../packages/database/src/vite.ts"),
      import("../../packages/kv/src/vite.ts"),
      import("../../packages/queue/src/vite.ts"),
      import("../../packages/schedule/src/vite.ts"),
      import("../../packages/sandbox/src/vite.ts"),
      import("../../packages/workspace/src/vite.ts"),
      import("../../packages/workflow/src/vite.ts"),
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
    const { hubBlob } = await import("../../packages/blob/src/vite.ts")
    return {
      ...baseConfig,
      blob: {},
      plugins: [hubBlob()],
    }
  }

  if (buildMode === VITEHUB_MODES.chat) {
    const { DevTools } = await import("@vitejs/devtools")
    const { hubAgent } = await import("../../packages/agent/src/vite.ts")
    const { hubDevtools } = await import("../../packages/devtools/src/index.ts")
    return {
      ...baseConfig,
      agent: {},
      plugins: [...await DevTools(), hubDevtools(), hubAgent()],
    }
  }

  if (buildMode === VITEHUB_MODES.env) {
    const { env, hubEnv } = await import("../../packages/env/src/vite.ts")
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
    const { hubWorkflow } = await import("../../packages/workflow/src/vite.ts")
    return {
      ...baseConfig,
      plugins: [hubWorkflow()],
      workflow: {},
    }
  }

  if (buildMode === VITEHUB_MODES.schedule) {
    const [{ hubKv }, { hubSchedule }] = await Promise.all([
      import("../../packages/kv/src/vite.ts"),
      import("../../packages/schedule/src/vite.ts"),
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
    const { hubWorkspace } = await import("../../packages/workspace/src/vite.ts")
    return {
      ...baseConfig,
      plugins: [hubWorkspace()],
      workspace: {},
    }
  }

  if (buildMode === VITEHUB_MODES.db) {
    const { hubDb } = await import("../../packages/database/src/vite.ts")
    return {
      ...baseConfig,
      plugins: [hubDb()],
    }
  }

  const [{ hubKv }, { hubQueue }] = await Promise.all([
    import("../../packages/kv/src/vite.ts"),
    import("../../packages/queue/src/vite.ts"),
  ])

  return {
    ...baseConfig,
    plugins: [hubQueue(), hubKv()],
    kv: {},
    queue: {},
  }
})
