import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"

import type { Plugin, PluginOption } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("../src/_internal/database/runtime/state", import.meta.url))

function fixtureDocument(id?: string) {
  return {
    invocations: id
      ? [{
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id,
          observations: [],
          status: "completed" as const,
          traceId: `${id}-trace`,
          updatedAt: "2026-08-27T10:00:00.000Z",
        }]
      : [],
    version: 1 as const,
  }
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

const mocks = vi.hoisted(() => ({
  objectHook: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
    },
  })),
  existingQueueConfig: vi.fn(),
  existingQueueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    queues: {
      handlers: [{ handler: "custom-server/queues/email.ts" }],
    },
  })),
  existingOwnerConfig: vi.fn((config: { nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      ownerPlugin: true,
    },
  })),
  envHook: vi.fn((config: Record<string, unknown>) => {
    config.envReady = true
  }),
  markdownTemplateLoad: vi.fn(),
  markdownTemplateResolveId: vi.fn(),
  outputHook: vi.fn(),
  agentHook: vi.fn((config: { [VITEHUB_SERVER_DIRS]?: string[]; nitro?: Record<string, unknown>; root?: string }) => {
    const replace = isTestRecord(config.nitro?.replace)
      ? config.nitro.replace
      : {}
    return {
      nitro: {
        ...config.nitro,
        handlers: config[VITEHUB_SERVER_DIRS]?.map(serverDir => ({
          handler: `${serverDir}/agents/support.ts`,
        })),
        modules: ["agent-module"],
        replace: {
          __VITEHUB_AGENT_APP_ROOT__: JSON.stringify(config.root),
          ...replace,
        },
      },
    }
  }),
  agentWorkflowRegistryTransform: vi.fn((code: string) => `// transformed\n${code}`),
  queueNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    unexpectedQueue: true,
  })),
  sandboxHook: vi.fn((config: { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean; nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      sandbox: config[VITEHUB_NITRO_CONFIG_CONTEXT],
    },
  })),
  useEnvPlugin: vi.fn(),
  uiModule: vi.fn(),
  vitehub: vi.fn(),
  workflowNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    workflows: true,
  })),
}))

vi.mock("../src/index.ts", () => ({ vitehub: mocks.vitehub }))
vi.mock("@vite-hub/ui/nuxt", () => ({ default: mocks.uiModule }))

import { consoleFixtureEnvironmentVariable } from "../src/console/fixture.ts"
import { consoleInvocationsRootIdentityRegistryKey } from "../src/console/internal.ts"
import viteHubNuxtModule from "../src/nuxt.ts"

function createNuxt(dev = false, plugins: PluginOption[] = []) {
  const builderWatchHooks: Array<(event: string, path: string) => Promise<void>> = []
  const closeHooks: Array<() => Promise<void>> = []
  const nitroConfigHooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
  const pageHooks: Array<(pages: Array<{ file: string, name: string, path: string }>) => void> = []
  const nuxt = {
    hook(name: "builder:watch" | "close" | "nitro:config" | "pages:extend", callback: (() => Promise<void>) | ((config: Record<string, unknown>) => Promise<void>) | ((pages: Array<{ file: string, name: string, path: string }>) => void)) {
      if (name === "nitro:config") nitroConfigHooks.push(callback as (config: Record<string, unknown>) => Promise<void>)
      else if (name === "builder:watch") builderWatchHooks.push(callback as (event: string, path: string) => Promise<void>)
      else if (name === "close") closeHooks.push(callback as () => Promise<void>)
      else pageHooks.push(callback as (pages: Array<{ file: string, name: string, path: string }>) => void)
    },
    options: {
      alias: {
        "~": "/tmp/vitehub-nuxt/app",
      },
      buildDir: "/tmp/vitehub-nuxt/.nuxt",
      dev,
      devServerHandlers: undefined as Array<{
        handler: (event: import("../src/console/runtime/server/request.ts").ConsoleRequestEvent) => void
        route?: string
      }> | undefined,
      modules: undefined as unknown[] | undefined,
      nitro: {} as Record<string, unknown>,
      rootDir: "/tmp/vitehub-nuxt",
      serverDir: "/tmp/vitehub-nuxt/custom-server",
      srcDir: "/tmp/vitehub-nuxt/app",
      vite: { plugins },
      vitehubCliDiscovery: undefined as true | undefined,
      watch: undefined as string[] | undefined,
    },
  }
  return {
    nitroConfigHooks,
    pageHooks,
    nuxt,
    async runBuilderWatchHook(path = "/tmp/vitehub-nuxt/console.fixture.json", event = "change") {
      for (const hook of builderWatchHooks) await hook(event, path)
    },
    async runCloseHook() {
      for (const hook of closeHooks) await hook()
    },
    async runNitroConfigHook(config: Record<string, unknown>) {
      if (!nitroConfigHooks.length) throw new TypeError("Expected a Nitro config hook.")
      for (const hook of nitroConfigHooks) await hook(config)
    },
    runPagesHook(pages: Array<{ file: string, name: string, path: string }>) {
      for (const hook of pageHooks) hook(pages)
    },
  }
}

function nitroOptions(nuxt: ReturnType<typeof createNuxt>["nuxt"]): Record<string, unknown> {
  // SAFETY: createNuxt initializes the Nitro options exercised by these fixtures.
  return (nuxt.options as typeof nuxt.options & { nitro: Record<string, unknown> }).nitro
}

function nitroPlugins(nuxt: ReturnType<typeof createNuxt>["nuxt"]): string[] {
  const plugins = nitroOptions(nuxt).plugins
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Nitro's plugin boundary accepts mixed values; this helper narrows the test fixture to generated paths.
  if (!Array.isArray(plugins) || !plugins.every(plugin => typeof plugin === "string")) {
    throw new TypeError("Expected string-valued Nitro plugins.")
  }
  return plugins
}

describe("ViteHub Nuxt integration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    mocks.objectHook.mockClear()
    mocks.agentHook.mockClear()
    mocks.agentWorkflowRegistryTransform.mockClear()
    mocks.existingQueueConfig.mockClear()
    mocks.existingQueueNitroConfig.mockClear()
    mocks.existingOwnerConfig.mockClear()
    mocks.envHook.mockClear()
    mocks.markdownTemplateLoad.mockClear()
    mocks.markdownTemplateResolveId.mockClear()
    mocks.outputHook.mockClear()
    mocks.queueNitroConfig.mockClear()
    mocks.sandboxHook.mockClear()
    mocks.useEnvPlugin.mockClear()
    mocks.uiModule.mockReset()
    mocks.workflowNitroConfig.mockClear()
    mocks.vitehub.mockReset()
    mocks.vitehub.mockReturnValue([
      false,
      [
        {
          name: "vite-hub/deployment-preset",
          config(config: { nitro?: Record<string, unknown> }) {
            // SAFETY: The Cloudflare deployment plugin owns this Nitro namespace.
            const cloudflare = config.nitro?.cloudflare as Record<string, unknown> | undefined
            // SAFETY: Cloudflare Nitro configuration owns the nested Wrangler namespace.
            const wrangler = cloudflare?.wrangler as Record<string, unknown> | undefined
            config.nitro = {
              ...config.nitro,
              cloudflare: {
                ...cloudflare,
                wrangler: {
                  ...wrangler,
                  name: "vitehub-nuxt",
                },
              },
              preset: "cloudflare_module",
            }
            // SAFETY: The hook fixture receives a mutable Nitro plugin configuration object.
            ;(config as Record<string, unknown>).queue = {
              namePrefix: "vitehub-nuxt-",
            }
          },
        },
      ],
      {
        name: "@vite-hub/agent/vite",
        config: mocks.agentHook,
        vitehub: {
          agent: {
            transformWorkflowRegistry: mocks.agentWorkflowRegistryTransform,
          },
        },
      },
      {
        name: "@vite-hub/queue/vite",
        config: vi.fn(),
        vitehub: {
          queue: {
            createNitroConfig: mocks.queueNitroConfig,
          },
        },
      },
      {
        name: "@vite-hub/sandbox/vite",
        config: mocks.sandboxHook,
      },
      {
        name: "@vite-hub/workflow/vite",
        vitehub: {
          workflow: {
            createNitroConfig: mocks.workflowNitroConfig,
          },
        },
      },
      {
        name: "vite-hub/object-hook",
        config: {
          handler: mocks.objectHook,
        },
      },
      {
        name: "vite-hub/deployment-output",
        enforce: "post",
        config: mocks.outputHook,
        vitehub: {
          deploymentOutput: {
            useEnvPlugin: mocks.useEnvPlugin,
          },
        },
      },
      {
        name: "@vite-hub/env/vite",
        api: {
          resolveProjectRoot: vi.fn((root: string) => {
            const envOptions = (
              // SAFETY: The vitehub mock records calls with the public options contract.
              mocks.vitehub.mock.calls.at(-1)?.[0] as
                | {
                    env?: { projectRoot?: string }
                  }
                | undefined
            )?.env
            return envOptions?.projectRoot ? resolve(root, envOptions.projectRoot) : resolveViteHubProjectRoot(root)
          }),
        },
        config: mocks.envHook,
      },
      {
        name: "@vite-hub/markdown-template/vite",
        load: mocks.markdownTemplateLoad,
        resolveId: mocks.markdownTemplateResolveId,
      },
    ])
  })

  it("loads colocated Markdown templates through Nitro Rollup", async () => {
    const existingPlugin: Plugin = { name: "existing-nitro-plugin" }
    const standaloneLoad = vi.fn()
    const standaloneResolveId = vi.fn()
    const { nuxt, runNitroConfigHook } = createNuxt(false, [{
      name: "@vite-hub/markdown-template/vite",
      load: standaloneLoad,
      resolveId: standaloneResolveId,
    }])
    const nitroConfig: { rollupConfig: { plugins: Plugin | Plugin[] } } = {
      rollupConfig: { plugins: existingPlugin },
    }
    const nestedResolve = vi.fn().mockResolvedValue({
      id: "\0raw:/app/server/api/name.md",
      meta: { marker: "preserved" },
    })
    const context = { marker: "nitro-context", resolve: nestedResolve }
    mocks.markdownTemplateResolveId.mockResolvedValueOnce(
      "\0raw:/app/server/api/reply.template.md?markdown-template",
    )
    mocks.markdownTemplateLoad.mockImplementationOnce(function (this: { resolve: typeof nestedResolve }) {
      return this.resolve("./name.md", "/app/server/api/reply.template.md")
    })

    await viteHubNuxtModule({ preset: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    // SAFETY: The Nitro configuration hook normalizes this plugin option to an array.
    const plugins = nitroConfig.rollupConfig.plugins as Plugin[]
    expect(plugins[0]).toBe(existingPlugin)
    expect(plugins.map(plugin => plugin.name)).toEqual([
      "existing-nitro-plugin",
      "vite-hub/nuxt-markdown-templates",
    ])

    const markdownPluginCandidate: unknown = plugins[1]
    // SAFETY: The preceding names assertion identifies the installed resolver and its function hooks.
    const markdownPlugin = markdownPluginCandidate as {
      load(this: typeof context, id: string): unknown
      resolveId(this: typeof context, source: string, importer: string): unknown
    }
    await expect(markdownPlugin.resolveId.call(context, "./reply.template.md", "/app/server/api/reply.ts")).resolves.toBe(
      "/app/server/api/reply.template.md?markdown-template",
    )
    await expect(markdownPlugin.load.call(
      context,
      "\0raw:/app/server/api/reply.template.md?markdown-template",
    )).resolves.toEqual({
      id: "/app/server/api/name.md",
      meta: { marker: "preserved" },
    })
    expect(mocks.markdownTemplateResolveId.mock.contexts[0]).toBe(context)
    expect(Object.getPrototypeOf(mocks.markdownTemplateLoad.mock.contexts[0])).toBe(context)
    expect(mocks.markdownTemplateLoad).toHaveBeenCalledWith(
      "/app/server/api/reply.template.md?markdown-template",
    )
    expect(standaloneResolveId).not.toHaveBeenCalled()
    expect(standaloneLoad).not.toHaveBeenCalled()
    expect(nestedResolve).toHaveBeenCalledWith("./name.md", "/app/server/api/reply.template.md")
  })

  it("installs the read-only console in Nuxt development and production", async () => {
    const development = createNuxt(true)
    const existingConsoleHandler = vi.fn()
    development.nuxt.options.devServerHandlers = [{ handler: existingConsoleHandler, route: "/api/_vitehub/console" }]
    await viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt)
    const pages: Array<{ file: string, name: string, path: string }> = []
    development.runPagesHook(pages)

    expect(mocks.uiModule).toHaveBeenCalledOnce()
    expect(pages).toEqual([
      expect.objectContaining({ name: "vitehub-console", path: "/_vitehub" }),
      expect.objectContaining({ name: "vitehub-console-agents", path: "/_vitehub/agents" }),
      expect.objectContaining({ name: "vitehub-console-agent", path: "/_vitehub/agents/:agent" }),
      expect.objectContaining({ name: "vitehub-console-invocation", path: "/_vitehub/agents/:agent/invocations/:invocation" }),
    ])
    expect(development.nuxt.options.nitro).toMatchObject({
      handlers: [
        { route: "/api/_vitehub/console/agents" },
        { route: "/api/_vitehub/console/invocations" },
        { route: "/api/_vitehub/console/invocations/:id" },
        { route: "/api/_vitehub/console/search" },
      ],
      plugins: ["/tmp/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs"],
    })
    expect(development.nuxt.options.devServerHandlers).toEqual([
      { handler: existingConsoleHandler, route: "/api/_vitehub/console" },
    ])
    expect(development.nuxt.options.vite.plugins).toContainEqual(
      expect.objectContaining({ name: "vite-hub/console-invocation-root" }),
    )
    expect(development.nuxt.options.vite.plugins).toContainEqual(
      expect.objectContaining({ name: "vite-hub/console-cli" }),
    )
    await expect(readFile("/tmp/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs", "utf8")).resolves.toContain(
      `const vitehubConsoleInvocations = installConsoleInvocations("/tmp/vitehub-nuxt")`,
    )
    await expect(readFile("/tmp/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs", "utf8")).resolves.toContain(
      `installConsoleAgentDefinitions([], vitehubConsoleInvocations)`,
    )

    mocks.uiModule.mockClear()
    const production = createNuxt(false)
    await viteHubNuxtModule({ console: { exposure: "host-managed" }, preset: "node" }, production.nuxt)
    expect(mocks.uiModule).toHaveBeenCalledOnce()
    const productionPages: Array<{ file: string, name: string, path: string }> = []
    production.runPagesHook(productionPages)
    expect(productionPages).toEqual([
      expect.objectContaining({ name: "vitehub-console", path: "/_vitehub" }),
      expect.objectContaining({ name: "vitehub-console-agents", path: "/_vitehub/agents" }),
      expect.objectContaining({ name: "vitehub-console-agent", path: "/_vitehub/agents/:agent" }),
      expect.objectContaining({ name: "vitehub-console-invocation", path: "/_vitehub/agents/:agent/invocations/:invocation" }),
    ])
    expect(production.nuxt.options.nitro).toMatchObject({
      handlers: [
        { route: "/api/_vitehub/console/agents" },
        { route: "/api/_vitehub/console/invocations" },
        { route: "/api/_vitehub/console/invocations/:id" },
        { route: "/api/_vitehub/console/search" },
      ],
      plugins: ["/tmp/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs"],
    })
    expect(production.nuxt.options.devServerHandlers).toBeUndefined()
    expect(production.nuxt.options.vite.plugins).toContainEqual(
      expect.objectContaining({ name: "vite-hub/console-invocation-root" }),
    )
  })

  it("loads Console fixtures in Nuxt development and rejects them in production", async () => {
    const fixture = "/tmp/vitehub-nuxt/console.fixture.json"
    await mkdir("/tmp/vitehub-nuxt", { recursive: true })
    await writeFile("/tmp/vitehub-nuxt/package.json", "{}\n")
    await writeFile(fixture, JSON.stringify(fixtureDocument()))
    vi.stubEnv("VITEHUB_CONSOLE_FIXTURE", fixture)
    try {
      const development = createNuxt(true)
      await viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt)

      const generatedPlugin = nitroPlugins(development.nuxt)[0] ?? ""
      const generated = await readFile(generatedPlugin, "utf8")
      expect(generated).toContain(`installConsoleFixtureInvocations("/tmp/vitehub-nuxt", ${JSON.stringify(fixture)}, `)
      expect(generated).toContain("JSON.parse(")
      expect(development.nuxt.options.watch).toContain(fixture)

      await writeFile(fixture, JSON.stringify(fixtureDocument("vite-startup")))
      // SAFETY: Nuxt stores Vite plugin options in the nested array shape flattened and guarded below.
      const invocationRootPlugin = (development.nuxt.options.vite.plugins as unknown[])
        .flat(Infinity)
        .find(candidate => isTestRecord(candidate) && candidate.name === "vite-hub/console-invocation-root")
      if (!isTestRecord(invocationRootPlugin)) throw new TypeError("Expected the Console invocation root plugin.")
      const configResolved = invocationRootPlugin.configResolved
      const configResolvedHandler = isTestRecord(configResolved) ? configResolved.handler : configResolved
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite exposes hooks as either functions or handler objects.
      if (typeof configResolvedHandler !== "function") throw new TypeError("Expected a Console configResolved hook.")
      await Reflect.apply(configResolvedHandler, {}, [{ root: "/tmp/vitehub-nuxt" }])
      await expect(readFile(generatedPlugin, "utf8")).resolves.toContain("vite-startup")

      await writeFile(fixture, JSON.stringify(fixtureDocument("replacement")))

      const concurrent = createNuxt(true)
      await viteHubNuxtModule({ console: true, preset: "node" }, concurrent.nuxt)
      const concurrentGeneratedPlugin = nitroPlugins(concurrent.nuxt)[0] ?? ""
      expect(concurrentGeneratedPlugin).not.toBe(generatedPlugin)
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(generated)
      await expect(readFile(concurrentGeneratedPlugin, "utf8")).resolves.toContain("replacement")

      await development.runBuilderWatchHook()
      const refreshed = await readFile(generatedPlugin, "utf8")
      expect(refreshed).not.toBe(generated)

      const agent = "/tmp/vitehub-nuxt/custom-server/agents/fixture-refresh.ts"
      await mkdir(resolve(agent, ".."), { recursive: true })
      await writeFile(agent, "export default { name: 'Fixture refresh' }\n")
      await development.runBuilderWatchHook(agent)
      const refreshedWithAgent = await readFile(generatedPlugin, "utf8")
      expect(refreshedWithAgent).toContain("fixture-refresh.ts")

      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
      await writeFile(fixture, "not json")
      await expect(development.runBuilderWatchHook()).resolves.toBeUndefined()
      await expect(development.runBuilderWatchHook(agent)).resolves.toBeUndefined()
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(refreshedWithAgent)
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Could not refresh Console development state"))
      await rm(agent)

      await rm(fixture)
      await expect(development.runBuilderWatchHook()).resolves.toBeUndefined()
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(refreshedWithAgent)

      await writeFile(fixture, JSON.stringify(fixtureDocument("restored")))
      await development.runBuilderWatchHook()
      await expect(readFile(generatedPlugin, "utf8")).resolves.not.toBe(refreshed)

      const closeBundle = invocationRootPlugin.closeBundle
      const closeBundleHandler = isTestRecord(closeBundle) ? closeBundle.handler : closeBundle
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite exposes hooks as either functions or handler objects.
      if (typeof closeBundleHandler !== "function") throw new TypeError("Expected a Console closeBundle hook.")
      await Reflect.apply(closeBundleHandler, {}, [])
      await expect(readFile(generatedPlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(concurrentGeneratedPlugin, "utf8")).resolves.toContain("replacement")

      const production = createNuxt(false)
      await expect(viteHubNuxtModule({ console: { exposure: "host-managed" }, preset: "node" }, production.nuxt))
        .rejects.toThrow("Console fixture mode is development-only")
    }
    finally {
      vi.unstubAllEnvs()
      await rm(fixture, { force: true })
      await rm("/tmp/vitehub-nuxt/package.json", { force: true })
    }
  })

  it("defers Console fixture installation until later Nuxt setup succeeds", async () => {
    const root = "/tmp/vitehub-nuxt-fixture-failure"
    const fixture = resolve(root, "console.fixture.json")
    await rm(root, { force: true, recursive: true })
    await mkdir(root, { recursive: true })
    await writeFile(resolve(root, "package.json"), "{}\n")
    await writeFile(fixture, JSON.stringify(fixtureDocument("failed-startup")))
    vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
    const installed = mocks.vitehub()
    const envPlugin = installed.flat(Infinity).find(
      (candidate: unknown) => isTestRecord(candidate) && candidate.name === "@vite-hub/env/vite",
    )
    if (!isTestRecord(envPlugin) || !isTestRecord(envPlugin.api)) throw new TypeError("Expected the Env plugin fixture.")
    envPlugin.api.prepareTypes = vi.fn().mockRejectedValue(new Error("type preparation failed"))
    mocks.vitehub.mockReturnValue(installed)
    const development = createNuxt(true)
    development.nuxt.options.rootDir = root
    development.nuxt.options.buildDir = resolve(root, ".nuxt")
    development.nuxt.options.serverDir = resolve(root, "server")

    try {
      await expect(viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt))
        .rejects.toThrow("type preparation failed")
      expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).not.toBe(true)
      expect(nitroOptions(development.nuxt).plugins).toBeUndefined()
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("releases Console fixture state when Nuxt closes before Vite buildStart", async () => {
    const root = "/tmp/vitehub-nuxt-fixture-vite-startup-failure"
    const fixture = resolve(root, "console.fixture.json")
    await rm(root, { force: true, recursive: true })
    await mkdir(root, { recursive: true })
    await writeFile(resolve(root, "package.json"), "{}\n")
    await writeFile(fixture, JSON.stringify(fixtureDocument("failed-vite-startup")))
    vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
    const development = createNuxt(true)
    development.nuxt.options.rootDir = root
    development.nuxt.options.buildDir = resolve(root, ".nuxt")
    development.nuxt.options.serverDir = resolve(root, "server")

    try {
      await viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt)
      const generatedPlugin = nitroPlugins(development.nuxt)[0] ?? ""
      await expect(readFile(generatedPlugin, "utf8")).resolves.toContain("failed-vite-startup")
      expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).toBe(true)

      await development.runCloseHook()

      expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).not.toBe(true)
      await expect(readFile(generatedPlugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not retain Console fixture storage when plugin generation fails", async () => {
    const root = "/tmp/vitehub-nuxt-fixture-generation-failure"
    const fixture = resolve(root, "console.fixture.json")
    await rm(root, { force: true, recursive: true })
    await mkdir(resolve(root, ".vitehub/nitro"), { recursive: true })
    await writeFile(resolve(root, "package.json"), "{}\n")
    await writeFile(fixture, JSON.stringify(fixtureDocument("failed-generation")))
    await writeFile(resolve(root, ".vitehub/nitro/console"), "not a directory\n")
    vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
    const development = createNuxt(true)
    development.nuxt.options.rootDir = root
    development.nuxt.options.buildDir = resolve(root, ".nuxt")
    development.nuxt.options.serverDir = resolve(root, "server")

    try {
      await expect(viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt))
        .rejects.toThrow()
      expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey)?.has(root)).not.toBe(true)
      expect(nitroOptions(development.nuxt).plugins).toEqual([])
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not open Console storage during CLI discovery", async () => {
    const root = "/tmp/vitehub-nuxt-cli-discovery"
    await rm(root, { force: true, recursive: true })
    const generatedPlugin = resolve(root, ".vitehub/nitro/console/plugin.mjs")
    const activeFixturePlugin = "// active fixture plugin\n"
    await mkdir(resolve(generatedPlugin, ".."), { recursive: true })
    await writeFile(generatedPlugin, activeFixturePlugin)
    const discovery = createNuxt(false)
    discovery.nuxt.options.rootDir = root
    discovery.nuxt.options.buildDir = resolve(root, ".nuxt")
    discovery.nuxt.options.vitehubCliDiscovery = true
    vi.stubEnv(consoleFixtureEnvironmentVariable, resolve(root, "missing.fixture.json"))

    try {
      await viteHubNuxtModule({ console: true, preset: "node" }, discovery.nuxt)
      await expect(readFile(resolve(root, ".vitehub/data/console.sqlite")))
        .rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(activeFixturePlugin)
      expect(discovery.nuxt.options.vite.plugins).toContainEqual(
        expect.objectContaining({ name: "vite-hub/console-cli" }),
      )
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects non-Node production console storage while preserving development", async () => {
    const development = createNuxt(true)
    await expect(viteHubNuxtModule({ console: true, preset: "cloudflare" }, development.nuxt))
      .resolves.toBeUndefined()
    expect(development.nuxt.options.nitro?.handlers).toContainEqual(
      expect.objectContaining({ route: "/api/_vitehub/console/search" }),
    )

    const production = createNuxt(false)
    await expect(viteHubNuxtModule({ console: true, preset: "cloudflare" }, production.nuxt))
      .rejects.toThrow('Console currently requires preset: "node" for production')
  })

  it("rejects bare production Console enablement", async () => {
    const production = createNuxt(false)

    await expect(viteHubNuxtModule({ console: true, preset: "node" }, production.nuxt))
      .rejects.toThrow("console: true is development-only")
  })

  it("discovers callback-backed Auth policy for a production Console", async () => {
    const authDefinition = "/tmp/vitehub-nuxt/custom-server/auth.ts"
    await mkdir(resolve(authDefinition, ".."), { recursive: true })
    await writeFile(authDefinition, `
      export default defineAuth({
        access: { routes: [
          { route: "/_vitehub/**", authorize: authorizeConsole },
          { route: "/api/_vitehub/console/**", authorize: authorizeConsole },
        ] },
      })
    `)
    try {
      const production = createNuxt(false)

      await expect(viteHubNuxtModule({
        auth: true,
        console: { access: "auth" },
        preset: "node",
      }, production.nuxt)).resolves.toBeUndefined()

      expect(nitroOptions(production.nuxt).handlers).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/api/_vitehub/console/agents" }),
      ]))
    }
    finally {
      await rm(authDefinition, { force: true })
    }
  })

  it("rejects Auth-backed production Console when replay config disables Auth", async () => {
    const production = createNuxt(false)
    Object.assign(production.nuxt.options.vite, { auth: false as const })

    await expect(viteHubNuxtModule({
      auth: true,
      console: { access: "auth" },
      preset: "node",
    }, production.nuxt)).rejects.toThrow("requires a discovered ViteHub Auth Definition")
  })

  it("uses the normalized relative Vite root for Auth assertion and middleware", async () => {
    const authDefinition = "/tmp/vitehub-nuxt/frontend/server/auth.ts"
    await mkdir(resolve(authDefinition, ".."), { recursive: true })
    await writeFile(authDefinition, `
      export default defineAuth({
        access: { routes: [
          { route: "/_vitehub/**", authorize: authorizeConsole },
          { route: "/api/_vitehub/console/**", authorize: authorizeConsole },
        ] },
      })
    `)
    try {
      const defaultPlugins = mocks.vitehub()
      const authConfig = vi.fn((config: { nitro?: { handlers?: unknown[] } }) => ({
        nitro: {
          ...config.nitro,
          handlers: [...(config.nitro?.handlers ?? []), { route: "/api/auth/**" }],
        },
      }))
      mocks.vitehub.mockClear()
      mocks.vitehub.mockReturnValueOnce([
        defaultPlugins,
        { config: authConfig, name: "@vite-hub/auth/vite" },
      ])
      const production = createNuxt(false)
      Reflect.deleteProperty(production.nuxt.options, "serverDir")
      Object.assign(production.nuxt.options.vite, { root: "frontend" })

      await viteHubNuxtModule({
        auth: true,
        console: { access: "auth" },
        preset: "node",
      }, production.nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await production.runNitroConfigHook(nitroConfig)

      expect(nitroConfig).toMatchObject({
        handlers: expect.arrayContaining([expect.objectContaining({ route: "/api/auth/**" })]),
      })
      expect(authConfig).toHaveBeenCalledWith(
        expect.objectContaining({ root: "/tmp/vitehub-nuxt/frontend" }),
        expect.anything(),
      )
    }
    finally {
      await rm("/tmp/vitehub-nuxt/frontend", { force: true, recursive: true })
    }
  })

  it("does not reinstall a configured ViteHub UI module for the console", async () => {
    const development = createNuxt(true)
    development.nuxt.options.modules = ["@vite-hub/ui/nuxt"]

    await viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt)

    expect(mocks.uiModule).not.toHaveBeenCalled()
  })

  it("does not reinstall the framework UI module alias for the console", async () => {
    const development = createNuxt(true)
    development.nuxt.options.modules = ["vite-hub/ui/nuxt"]

    await viteHubNuxtModule({ console: true, preset: "node" }, development.nuxt)

    expect(mocks.uiModule).not.toHaveBeenCalled()
  })

  it("does not install the console when the option is omitted", async () => {
    const { nuxt, pageHooks } = createNuxt(true)
    await viteHubNuxtModule({ preset: "node" }, nuxt)

    expect(mocks.uiModule).not.toHaveBeenCalled()
    expect(pageHooks).toHaveLength(0)
    expect(nuxt.options.nitro).not.toHaveProperty("handlers")
  })

  it("does not install the console when explicitly disabled", async () => {
    const { nuxt, pageHooks } = createNuxt(true)
    await viteHubNuxtModule({ console: false, preset: "node" }, nuxt)

    expect(mocks.uiModule).not.toHaveBeenCalled()
    expect(pageHooks).toHaveLength(0)
    expect(nuxt.options.nitro).not.toHaveProperty("handlers")
    expect(nuxt.options.vite.plugins).not.toContainEqual(
      expect.objectContaining({ name: "vite-hub/console-invocation-root" }),
    )
  })

  it.each([
    ["cloudflare", "cloudflare-module"],
    ["vercel", "vercel"],
  ] as const)("exposes the %s Nitro preset during Nuxt module setup", async (preset, nitroPreset) => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({ preset: nitroPreset })
  })

  it("rejects a conflicting Nitro preset during Nuxt module setup", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, { nitro: { preset: "vercel" } })

    await expect(viteHubNuxtModule({ preset: "cloudflare" }, nuxt)).rejects.toThrow(
      'vitehub preset "cloudflare" conflicts with nitro.preset "vercel"',
    )
  })

  it("defaults Cloudflare WASM loading to lazy during Nuxt module setup", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({ wasm: { lazy: true } })
  })

  it("preserves explicit Nuxt WASM loading and leaves other presets unchanged", async () => {
    const { nuxt: cloudflareNuxt } = createNuxt()
    Object.assign(cloudflareNuxt.options, { nitro: { wasm: { lazy: false } } })

    await viteHubNuxtModule({ preset: "cloudflare" }, cloudflareNuxt)

    expect(nitroOptions(cloudflareNuxt)).toMatchObject({ wasm: { lazy: false } })

    const { nuxt: vercelNuxt } = createNuxt()
    await viteHubNuxtModule({ preset: "vercel" }, vercelNuxt)

    expect(nitroOptions(vercelNuxt)).not.toHaveProperty("wasm")
  })

  it("installs flattened ViteHub plugins and applies their config hooks to Nitro", async () => {
    const existingPlugin = {
      name: "vite-hub/object-hook",
      config: {
        handler: mocks.objectHook,
      },
    }
    const existingQueuePlugin = {
      name: "@vite-hub/queue/vite",
      config: mocks.existingQueueConfig,
      vitehub: {
        queue: {
          createNitroConfig: mocks.existingQueueNitroConfig,
        },
      },
    }
    const existingOwnerPlugin = {
      name: "@vite-hub/auth/vite",
      config: mocks.existingOwnerConfig,
    }
    const { nuxt, runNitroConfigHook } = createNuxt(true, [
      [existingQueuePlugin, existingOwnerPlugin, existingPlugin, { name: "vite-hub/deployment-output" }],
    ])
    mocks.outputHook.mockImplementationOnce((config: { nitro?: Record<string, unknown> }) => {
      // SAFETY: This focused fixture adds envReady to the mutable config object.
      if (!(config as Record<string, unknown>).envReady) return
      // SAFETY: This fixture constructs Nitro's Cloudflare configuration as a key-value object.
      const cloudflare = config.nitro?.cloudflare as Record<string, unknown> | undefined
      // SAFETY: This fixture constructs Cloudflare's Wrangler configuration as a key-value object.
      const wrangler = cloudflare?.wrangler as Record<string, unknown> | undefined
      config.nitro = {
        ...config.nitro,
        cloudflare: {
          ...cloudflare,
          wrangler: {
            ...wrangler,
            secrets: { required: ["VITEHUB_TOKEN"] },
          },
        },
      }
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(
      (
        // SAFETY: The output plugin records its generated root on the mutable Vite configuration.
        nuxt.options.vite as typeof nuxt.options.vite & {
          [VITEHUB_GENERATED_ROOT]?: string
        }
      )[VITEHUB_GENERATED_ROOT],
    ).toBe("/tmp/vitehub-nuxt/.nuxt/vitehub")
    expect(
      (
        // SAFETY: The output plugin records its server directories on the mutable Vite configuration.
        nuxt.options.vite as typeof nuxt.options.vite & {
          [VITEHUB_SERVER_DIRS]?: string[]
        }
      )[VITEHUB_SERVER_DIRS],
    ).toEqual(["/tmp/vitehub-nuxt/custom-server"])
    // SAFETY: Nuxt normalizes configured Vite plugins to an array before module setup completes.
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
      expect.objectContaining({ name: "vite-hub/deployment-preset" }),
      expect.objectContaining({ name: "@vite-hub/agent/vite" }),
      expect.objectContaining({ name: "@vite-hub/sandbox/vite" }),
      expect.objectContaining({ name: "@vite-hub/workflow/vite" }),
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
      expect.objectContaining({ name: "@vite-hub/markdown-template/vite" }),
      existingQueuePlugin,
      existingOwnerPlugin,
      existingPlugin,
    ])

    const d1Binding = {
      binding: "DB",
      database_id: "database-id",
      database_name: "database-name",
    }
    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          observability: { enabled: true },
        },
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect(mocks.existingQueueConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: { namePrefix: "vitehub-nuxt-" },
      }),
      expect.anything(),
    )
    expect(mocks.existingQueueNitroConfig).toHaveBeenCalledWith({
      development: true,
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: "/tmp/vitehub-nuxt",
      root: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    expect(mocks.workflowNitroConfig).toHaveBeenCalledWith({
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
      transformRegistry: mocks.agentWorkflowRegistryTransform,
    })
    expect(mocks.queueNitroConfig).not.toHaveBeenCalled()
    expect(mocks.existingOwnerConfig).toHaveBeenCalledOnce()
    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_GENERATED_ROOT]: "/tmp/vitehub-nuxt/.nuxt/vitehub",
        [VITEHUB_SERVER_DIRS]: ["/tmp/vitehub-nuxt/custom-server"],
      }),
      expect.anything(),
    )
    expect(mocks.sandboxHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      }),
      expect.anything(),
    )
    expect(mocks.objectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({ preset: "cloudflare_module" }),
        resolve: {
          alias: {
            "#vitehub/env/public": "/tmp/vitehub-nuxt/.vitehub/env/public.mjs",
            "#vitehub/env/server": "/tmp/vitehub-nuxt/.vitehub/env/server.mjs",
            "~": "/tmp/vitehub-nuxt/app",
          },
        },
        root: "/tmp/vitehub-nuxt",
      }),
      {
        command: "serve",
        isPreview: false,
        isSsrBuild: true,
        mode: "development",
      },
    )
    expect(mocks.outputHook).toHaveBeenCalledOnce()
    expect(mocks.envHook).toHaveBeenCalledOnce()
    expect(mocks.useEnvPlugin).toHaveBeenCalledWith(expect.objectContaining({ name: "@vite-hub/env/vite" }))
    expect(nitroConfig).toEqual({
      alias: {
        "#vitehub/env/public": "/tmp/vitehub-nuxt/.vitehub/env/public.mjs",
        "#vitehub/env/server": "/tmp/vitehub-nuxt/.vitehub/env/server.mjs",
      },
      cloudflare: {
        wrangler: {
          d1_databases: [d1Binding, d1Binding],
          name: "vitehub-nuxt",
          observability: { enabled: true },
          secrets: { required: ["VITEHUB_TOKEN"] },
        },
      },
      ownerPlugin: true,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
      modules: ["agent-module"],
      preset: "cloudflare_module",
      queues: {
        handlers: [{ handler: "custom-server/queues/email.ts" }],
      },
      replace: {
        __VITEHUB_AGENT_APP_ROOT__: JSON.stringify("/tmp/vitehub-nuxt"),
      },
      rollupConfig: {
        plugins: [expect.objectContaining({ name: "vite-hub/nuxt-markdown-templates" })],
      },
      sandbox: true,
      workflows: true,
    })
  })

  it("binds deployment output to an existing Env plugin selected for replay", async () => {
    const existingEnvPlugin = {
      name: "@vite-hub/env/vite",
      api: { resolveProjectRoot: (root: string) => resolveViteHubProjectRoot(root) },
      config: vi.fn(),
    }
    const { nuxt } = createNuxt(false, [existingEnvPlugin])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(mocks.useEnvPlugin).toHaveBeenCalledWith(existingEnvPlugin)
    // SAFETY: Nuxt stores Vite plugin options as the nested array shape flattened here.
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toContain(existingEnvPlugin)
  })

  it("replays configured Nuxt Vite options into Nitro hooks", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: "/tmp/vitehub-nuxt/custom-vite-root",
      workspace: false,
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    const nitroConfig = {
      replace: {
        __VITEHUB_EXISTING_REPLACEMENT__: "existing",
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/tmp/vitehub-nuxt/custom-vite-root",
        workspace: false,
      }),
      expect.anything(),
    )
    expect(nitroConfig.replace).toEqual({
      __VITEHUB_AGENT_APP_ROOT__: JSON.stringify("/tmp/vitehub-nuxt/custom-vite-root"),
      __VITEHUB_EXISTING_REPLACEMENT__: "existing",
    })
  })

  it("finalizes deployment output after later ViteHub post hooks", async () => {
    const lateCloudflarePlugin = {
      name: "vite-hub/custom-cloudflare",
      enforce: "post" as const,
      config() {
        return {
          nitro: {
            cloudflare: {
              wrangler: {
                env: { staging: { name: "staging-worker" } },
              },
            },
          },
        }
      },
    }
    const { nuxt, runNitroConfigHook } = createNuxt(false, [lateCloudflarePlugin])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    await runNitroConfigHook({})

    expect(mocks.outputHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({
          cloudflare: expect.objectContaining({
            wrangler: expect.objectContaining({ env: { staging: { name: "staging-worker" } } }),
          }),
        }),
      }),
      expect.anything(),
    )
  })

  it("adds generated and Cloudflare types to Nuxt and Nitro", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(nuxt.options).toMatchObject({
      nitro: {
        typescript: {
          tsConfig: {
            include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
          },
        },
      },
      typescript: {
        tsConfig: {
          include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
        },
      },
    })
  })

  it("exposes materialized Email templates to Nuxt and Nitro on Vercel", async () => {
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: vi.fn() },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ email: true, preset: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    // SAFETY: The module initializes Nuxt aliases to a string map.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect(
      // SAFETY: The module initializes Nitro aliases before the configuration hook completes.
      (nuxt.options as typeof nuxt.options & { nitro: { alias: Record<string, string> } }).nitro.alias[
        "#vitehub/emails"
      ],
    ).toBe(emailTemplates)
    // SAFETY: The Nitro hook initializes aliases as a string map.
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("materializes Email templates before Cloudflare Workflow preparation", async () => {
    const prepareTypes = vi.fn().mockResolvedValue({
      "monthly-recap": "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly-recap.mjs",
      "monthly-recap/detail": "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly-recap%2Fdetail.mjs",
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ email: true, preset: "cloudflare" }, nuxt)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails/monthly-recap"]).toBe(
      `${emailTemplates}/monthly-recap.mjs`,
    )
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails/monthly-recap/detail"]).toBe(
      `${emailTemplates}/monthly-recap%2Fdetail.mjs`,
    )
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    expect(
      // SAFETY: The module initializes Nitro aliases before the configuration hook completes.
      (nuxt.options as typeof nuxt.options & { nitro: { alias: Record<string, string> } }).nitro.alias[
        "#vitehub/emails"
      ],
    ).toBe(emailTemplates)
  })

  it("resolves live-added nested Email templates dynamically during Nuxt development", async () => {
    const prepareTypes = vi.fn().mockResolvedValue({
      monthly: "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly.mjs",
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ email: true, preset: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(nuxt.options.alias).not.toHaveProperty("#vitehub/emails/monthly")
    // SAFETY: The email integration installs Rollup plugin objects into this owned namespace.
    const rollupConfig = nitroConfig.rollupConfig as {
      plugins: Array<{ name: string; resolveId: (id: string) => string | undefined }>
    }
    const resolver = rollupConfig.plugins.find(plugin => plugin.name === "vite-hub/nuxt-email-templates")
    expect(resolver?.resolveId("#vitehub/emails/monthly/detail")).toBe(
      "/tmp/vitehub-nuxt/.vitehub/email/templates/monthly%2Fdetail.mjs",
    )
  })

  it("exposes templates from a directly installed Email plugin", async () => {
    const prepareTypes = vi.fn()
    const { nuxt, runNitroConfigHook } = createNuxt(false, [
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    // SAFETY: The Nitro hook initializes aliases as a string map.
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("materializes and exposes Email templates on non-host-specific Nitro presets", async () => {
    const prepareTypes = vi.fn()
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ email: { driver: "resend" }, preset: "node" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    const emailTemplates = "/tmp/vitehub-nuxt/.vitehub/email/templates"
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    // SAFETY: The Nitro hook initializes aliases as a string map.
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("includes generated types from a configured Env project root", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: { projectRoot: "apps/api" }, preset: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../apps/api/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../apps/api/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("accepts Env declarations under vitehub and installs generated runtime aliases", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    const githubToken = { source: "GITHUB_TOKEN" }

    await viteHubNuxtModule(
      // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
      {
        env: {
          projectRoot: "apps/api",
          server: { githubToken },
        },
        preset: "node",
      } as never,
      nuxt,
    )

    expect(mocks.vitehub).toHaveBeenCalledWith({
      env: { projectRoot: "apps/api" },
      preset: "node",
    })
    expect(nuxt.options.vite).toMatchObject({
      env: { server: { githubToken } },
    })
    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/apps/api/.vitehub/env/server.mjs",
    })

    const nitroConfig = { alias: { "#custom": "./custom.mjs" } }
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/apps/api/.vitehub/env/server.mjs",
      "#custom": "./custom.mjs",
    })
  })

  it("prepares Env types before collecting generated declarations", async () => {
    const steps: string[] = []
    const prepareEnvTypes = vi.fn(async () => {
      steps.push("env")
    })
    const prepareTypes = vi.fn(async () => {
      steps.push("types")
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: prepareEnvTypes, resolveProjectRoot: (root: string) => root },
        name: "@vite-hub/env/vite",
      },
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt } = createNuxt()
    const githubToken = { source: "GITHUB_TOKEN" }
    const appName = { source: "PUBLIC_APP_NAME" }
    // SAFETY: This fixture extends the mutable Vite options with ViteHub's Env declaration.
    ;(nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }).env = {
      public: { appName },
    }

    // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
    await viteHubNuxtModule({ env: { server: { githubToken } }, preset: "node" } as never, nuxt)

    expect(prepareEnvTypes).toHaveBeenCalledWith({ public: { appName }, server: { githubToken } }, "/tmp/vitehub-nuxt")
    expect(steps).toEqual(["env", "types"])
  })

  it("removes disabled Email types before collecting generated declarations", async () => {
    const steps: string[] = []
    const cleanupEmailTypes = vi.fn(async () => {
      steps.push("email")
    })
    const prepareTypes = vi.fn(async () => {
      steps.push("types")
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: cleanupEmailTypes },
        name: "@vite-hub/email/optional-peer-resolver",
      },
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt } = createNuxt()

    // SAFETY: This focused lifecycle test invokes the Nuxt module through its test harness signature.
    await viteHubNuxtModule({ preset: "node" } as never, nuxt)

    expect(cleanupEmailTypes).toHaveBeenCalledWith("/tmp/vitehub-nuxt")
    expect(steps).toEqual(["email", "types"])
  })

  it("registers generated Collection handlers without replacing unrelated handlers", async () => {
    const generated = {
      handler: "/tmp/vitehub-nuxt/.vitehub/source/routes/meals.mjs",
      method: "get" as const,
      route: "/api/meals",
    }
    const prepareTypes = vi.fn(async () => [generated])
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ preset: "node" }, nuxt)
    const existing = { handler: "server/health.ts", method: "get", route: "/api/health" }
    const nitroConfig = { handlers: [existing] }
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      projectRoot: "/tmp/vitehub-nuxt",
      serverDirs: ["/tmp/vitehub-nuxt/custom-server"],
    })
    expect(nitroConfig.handlers).toEqual([existing, generated])
  })

  it("rejects handlers that bypass a generated Collection route", async () => {
    const generated = {
      handler: "/tmp/vitehub-nuxt/.vitehub/source/routes/meals.mjs",
      method: "get" as const,
      route: "/api/meals",
    }
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: vi.fn(async () => [generated]) },
        name: "vite-hub/types",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ preset: "node" }, nuxt)

    await expect(
      runNitroConfigHook({
        handlers: [{ handler: "server/api/meals.get.ts", method: "get", route: "/api/meals" }],
      }),
    ).rejects.toThrow('Generated Collection route "/api/meals" conflicts with an existing GET handler')
  })

  it("rejects scanned server routes that bypass a generated Collection route", async () => {
    const generated = {
      handler: "/tmp/vitehub-nuxt/.vitehub/source/routes/meals.mjs",
      method: "get" as const,
      route: "/api/meals",
    }
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: vi.fn(async () => [generated]) },
        name: "vite-hub/types",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ preset: "node" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    // SAFETY: The module hook populates Nitro's modules array before this assertion.
    const modules = nitroConfig.modules as Array<{
      name?: string
      setup?: (nitro: {
        hooks: { hook: (name: "build:before", callback: () => void) => void }
        scannedHandlers: Array<{ method?: string; route?: string }>
      }) => void
    }>
    const guard = modules.find(module => module.name === "vite-hub/generated-route-guard")
    let checkRoutes = () => {}
    guard?.setup?.({
      hooks: {
        hook(_name, callback) {
          checkRoutes = callback
        },
      },
      scannedHandlers: [{ route: "/api/meals" }],
    })

    expect(checkRoutes).toThrow('Generated Collection route "/api/meals" conflicts with an existing GET handler')
  })

  it("replaces existing Env array declarations instead of concatenating data values", async () => {
    const { nuxt } = createNuxt()
    // SAFETY: This fixture extends the mutable Vite options with ViteHub's Env declaration.
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = { public: { regions: ["old"] } }

    await viteHubNuxtModule(
      // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
      {
        env: { public: { regions: ["new"] } },
        preset: "node",
      } as never,
      nuxt,
    )

    expect(vite.env).toMatchObject({ public: { regions: ["new"] } })
  })

  it("merges nested Env declaration namespaces without merging declaration leaves", async () => {
    const { nuxt } = createNuxt()
    // SAFETY: This fixture extends the mutable Vite options with ViteHub's Env declaration.
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = {
      server: {
        database: {
          password: { source: "OLD_PASSWORD" },
          url: { source: "DATABASE_URL" },
        },
      },
    }

    await viteHubNuxtModule(
      // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
      {
        env: { server: { database: { password: { source: "DATABASE_PASSWORD" } } } },
        preset: "node",
      } as never,
      nuxt,
    )

    expect(vite.env).toMatchObject({
      server: {
        database: {
          password: { source: "DATABASE_PASSWORD" },
          url: { source: "DATABASE_URL" },
        },
      },
    })
  })

  it("preserves Env namespace children named source and kind", async () => {
    const { nuxt } = createNuxt()
    // SAFETY: This fixture extends the mutable Vite options with ViteHub's Env declaration.
    const vite = nuxt.options.vite as typeof nuxt.options.vite & { env?: Record<string, unknown> }
    vite.env = {
      server: {
        service: {
          kind: { source: "SERVICE_KIND" },
          source: { source: "SERVICE_SOURCE" },
        },
      },
    }

    await viteHubNuxtModule(
      // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
      {
        env: { server: { service: { token: { source: "SERVICE_TOKEN" } } } },
        preset: "node",
      } as never,
      nuxt,
    )

    expect(vite.env).toMatchObject({
      server: {
        service: {
          kind: { source: "SERVICE_KIND" },
          source: { source: "SERVICE_SOURCE" },
          token: { source: "SERVICE_TOKEN" },
        },
      },
    })
  })

  it("derives Env aliases from an existing Env Vite plugin", async () => {
    const envPlugin = {
      name: "@vite-hub/env/vite",
      api: {
        resolveProjectRoot: (root: string) => resolve(root, "packages/config"),
      },
    }
    const { nuxt } = createNuxt(false, [envPlugin])

    await viteHubNuxtModule({ preset: "node" }, nuxt)

    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": "/tmp/vitehub-nuxt/packages/config/.vitehub/env/server.mjs",
    })
  })

  it("keeps Env runtime aliases disabled", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: false, preset: "node" }, nuxt)

    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    const alias = nuxt.options.alias as Record<string, string>
    expect(alias).not.toHaveProperty("#vitehub/env/server")
  })

  it("includes generated types from every configured integration project root", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule(
      {
        channels: { projectRoot: "apps/api" },
        env: { projectRoot: "packages/config" },
        preset: "node",
      },
      nuxt,
    )

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../apps/api/.vitehub/data/**/*.d.ts", "../packages/config/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../apps/api/.vitehub/**/*.d.ts", "../packages/config/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("resolves generated type roots from the effective Vite root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ env: { projectRoot: "packages/config" }, preset: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../app/packages/config/.vitehub/data/**/*.d.ts"],
        include: ["../app/.vitehub/types.d.ts", "../app/packages/config/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("resolves Database generated types from the Nuxt root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ database: { projectRoot: "packages/db" }, preset: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../packages/db/.vitehub/data/**/*.d.ts"],
        include: ["../app/.vitehub/types.d.ts", "../packages/db/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("includes the effective top-level Database project root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      database: { projectRoot: "packages/db" },
    })

    await viteHubNuxtModule({ database: true, preset: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../packages/db/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../packages/db/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("installs the Database Nuxt runtime alias through the framework module", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: "/tmp/vitehub-nuxt/custom-vite-root",
    })

    await viteHubNuxtModule(
      { database: { databaseId: "content-id", databaseName: "content" }, preset: "cloudflare" },
      nuxt,
    )
    const nitroConfig = {}
    await runNitroConfigHook(nitroConfig)

    // SAFETY: Nuxt normalizes configured Vite plugins to an array before module setup completes.
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toContainEqual(
      expect.objectContaining({ name: "@vite-hub/database/vite" }),
    )
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"]).toBe(
      databaseRuntimeState,
    )
    expect(nitroConfig).toMatchObject({
      alias: {
        "@vite-hub/database/drizzle": "/tmp/vitehub-nuxt/.vitehub/database/cloudflare-runtime.mjs",
        "@vite-hub/database/runtime/state": databaseRuntimeState,
      },
    })
  })

  it("keeps the Database Nitro runtime alias out of development", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ database: true, preset: "cloudflare" }, nuxt)
    const nitroConfig = {}
    await runNitroConfigHook(nitroConfig)

    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"]).toBe(
      databaseRuntimeState,
    )
    expect(nitroConfig).not.toHaveProperty("alias.@vite-hub/database/runtime/state")
  })

  it("preserves an explicitly configured Database runtime alias", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.alias, {
      "@vite-hub/database/runtime/state": "./custom-nuxt-database-state.ts",
    })

    await viteHubNuxtModule(
      { database: { databaseId: "content-id", databaseName: "content" }, preset: "cloudflare" },
      nuxt,
    )
    const nitroConfig = {
      alias: {
        "@vite-hub/database/runtime/state": "./custom-database-state.ts",
      },
    }
    await runNitroConfigHook(nitroConfig)

    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["@vite-hub/database/runtime/state"]).toBe(
      "./custom-nuxt-database-state.ts",
    )
    expect(nitroConfig.alias["@vite-hub/database/runtime/state"]).toBe("./custom-database-state.ts")
  })

  it("installs the Auth Vue and server runtime integration through the framework module", async () => {
    const { nitroConfigHooks, nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, preset: "cloudflare" }, nuxt)

    // SAFETY: The Auth integration initializes imports and Nitro runtime configuration.
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string; name: string }> }
      nitro: { alias: Record<string, string>; plugins: string[] }
    }
    expect(options.imports.imports).toEqual([
      { from: "vite-hub/source/client", name: "useCollection" },
      { from: "vite-hub/auth/vue", name: "useAuthClient" },
      { from: "vite-hub/auth/vue", name: "useSession" },
      { from: "vite-hub/auth/vue", name: "useSignIn" },
      { from: "vite-hub/auth/vue", name: "useSignUp" },
      { from: "vite-hub/auth/vue", name: "useUserSession" },
    ])
    expect(options.nitro.alias["#vitehub/env/server"]).toBe("/tmp/vitehub-nuxt/.vitehub/env/server.mjs")
    expect(options.nitro.plugins).toHaveLength(1)
    expect(options.nitro.plugins[0]).toMatch(/\/runtime\/nuxt\.js$/)
    expect(nitroConfigHooks).toHaveLength(1)
  })

  it("auto-imports Agent Vue clients only when Agent Definitions are enabled", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt)

    // SAFETY: The Agent integration initializes Nuxt's imports collection.
    expect(
      (
        // SAFETY: The Agent integration initializes Nuxt's imports collection.
        nuxt.options as typeof nuxt.options & {
          imports: { imports: Array<{ from: string; name: string }> }
        }
      ).imports.imports,
    ).toEqual([
      { from: "vite-hub/agent/vue", name: "useAgent" },
      { from: "vite-hub/agent/vue", name: "useAgentInvocation" },
      { from: "vite-hub/agent/vue", name: "useAgentInvocations" },
      { from: "vite-hub/agent/vue", name: "useChat" },
      { from: "vite-hub/source/client", name: "useCollection" },
    ])
  })

  it("rejects a configured Nuxt composable that would bind a different useChat", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await expect(viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt)).rejects.toThrow(
      "Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from @ai-sdk/vue",
    )
  })

  it("checks Nuxt composable collisions against their exposed aliases", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ as: "useAiChat", from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await viteHubNuxtModule({ agent: true, preset: "cloudflare" }, nuxt)
    expect(
      (
        // SAFETY: The Agent integration initializes Nuxt's imports collection.
        nuxt.options as typeof nuxt.options & {
          imports: { imports: Array<{ as?: string; from: string; name: string }> }
        }
      ).imports.imports,
    ).toContainEqual({ from: "vite-hub/agent/vue", name: "useChat" })

    const { nuxt: conflictingNuxt } = createNuxt()
    Object.assign(conflictingNuxt.options, {
      imports: { imports: [{ as: "useChat", from: "custom-chat", name: "chat" }] },
    })
    await expect(viteHubNuxtModule({ agent: true, preset: "cloudflare" }, conflictingNuxt)).rejects.toThrow(
      "Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from custom-chat",
    )
  })

  it("auto-imports Realtime definition and Vue helpers", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ preset: "cloudflare", realtime: true }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({
      preset: "cloudflare-durable",
      wasm: { lazy: true },
    })
    const imports = (
      // SAFETY: The Realtime integration initializes Nuxt's imports collection.
      nuxt.options as typeof nuxt.options & {
        imports: { imports: Array<{ from: string; name: string }> }
      }
    ).imports.imports
    expect(imports).toContainEqual({
      from: "vite-hub/realtime",
      name: "defineRealtime",
    })
    expect(imports).toContainEqual({
      from: "vite-hub/realtime/vue",
      name: "useRealtimeTiptap",
    })
  })

  it("does not resolve a relative Vite root twice for Auth Env imports", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })

    await viteHubNuxtModule({ auth: true, preset: "cloudflare" }, nuxt)

    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe(
      resolve(".vitehub/env/server.mjs"),
    )
  })

  it("keeps Auth composables without Env runtime wiring", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, env: false, preset: "cloudflare" }, nuxt)

    // SAFETY: The Auth integration initializes imports and Nitro runtime configuration.
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string; name: string }> }
      nitro: Record<string, unknown>
    }
    expect(options.imports.imports).toHaveLength(6)
    expect(options.alias).not.toHaveProperty("#vitehub/env/server")
    expect(options.nitro.alias).toEqual({})
    expect(options.nitro).not.toHaveProperty("plugins")
  })

  it("does not concatenate complete Nitro arrays returned by config hooks", async () => {
    mocks.vitehub.mockReturnValue([
      {
        name: "vite-hub/first",
        config: () => ({
          nitro: {
            modules: ["first"],
          },
        }),
      },
      {
        name: "vite-hub/second",
        config: (config: { nitro?: Record<string, unknown> }) => ({
          nitro: {
            ...config.nitro,
            // SAFETY: This fixture owns Nitro's modules array and appends to that string list.
            modules: [...((config.nitro?.modules as string[] | undefined) ?? []), "second"],
          },
        }),
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig = {}

    await viteHubNuxtModule({ preset: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      modules: ["first", "second"],
    })
  })

  it("does nothing when Nuxt has not initialized", async () => {
    await expect(viteHubNuxtModule({ preset: "node" })).resolves.toBeUndefined()
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })

  it("merges top-level Nuxt options with inline module options", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      vitehub: {
        agent: true,
        preset: "node",
      },
    })

    await viteHubNuxtModule({ preset: "cloudflare" }, nuxt)

    expect(mocks.vitehub).toHaveBeenCalledWith({
      agent: true,
      preset: "cloudflare",
    })
  })

  it("exposes Nuxt module metadata for vitehub configuration", () => {
    expect(viteHubNuxtModule.getMeta()).toEqual({
      configKey: "vitehub",
      name: "vite-hub/nuxt",
    })
  })
})
