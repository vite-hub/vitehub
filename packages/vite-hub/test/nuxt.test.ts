import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"
import ts from "typescript"
import { resolveConfig } from "vite"
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest"

import {
  getResolvedFeatureOptions,
  resolveViteHubProjectRoot,
  setResolvedFeatureOptions,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_PROJECT_ROOT,
  VITEHUB_ENV_SERVER,
  VITEHUB_FEATURES,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { collectViteHubProviderOutputEntries } from "@vite-hub/internal/inspect"
import { viteHubDevPeerUpgradeListener } from "@vite-hub/internal/dev-peer"
import { resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { hubBlob } from "@vite-hub/blob/vite"
import { hubBrowser } from "@vite-hub/browser/vite"
import { hubAgent } from "@vite-hub/agent/vite"
import { hubContent } from "@vite-hub/content/vite"
import { hubComments } from "@vite-hub/comments/vite"
import { env, hubEnv } from "@vite-hub/env/vite"
import { hubKV, kvStorageDriver } from "@vite-hub/kv/vite"
import { hubRealtime } from "@vite-hub/realtime/vite"
import { viteHubUIIcons } from "@vite-hub/ui/nuxt"
import type { ConfigEnv, Plugin, PluginOption, UserConfig } from "vite"
import type { BlobOptions } from "@vite-hub/blob"
import { getConsoleSections } from "../src/console/runtime/server/sections.ts"
import { forgetPackageChecks } from "../src/internal/optional-owners.ts"

const h3RuntimeRoot = dirname(fileURLToPath(import.meta.resolve("h3/package.json")))
const kvCacheDriver = kvStorageDriver
const databaseRuntimeState = fileURLToPath(new URL("../dist/internal/database-runtime-state.js", import.meta.url))

// Each run gets its own fixture directories, so two runs at the same time do not overwrite each other.
const tmp = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-test-"))
afterAll(async () => await rm(tmp, { force: true, recursive: true }))
/** The generated `installConsoleSections()` call of the fixture root, with `kv` in its sections. */
const kvConsoleSections = new RegExp(String.raw`installConsoleSections\("${tmp.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}/vitehub-nuxt", \[[^\]]*"kv"`)

/** A replayed config hook that resolves feature options, as the `vitehub()` deployment hook does. */
function resolvedFeatures(features: Record<string, unknown>): UserConfig {
  // SAFETY: Owner plugins read this private key, and Vite keeps unknown keys on a config.
  return { [VITEHUB_FEATURES]: features } as UserConfig
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && Object(value) === value && Object.getPrototypeOf(value) === Object.prototype
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
  sandboxTaskHook: vi.fn((config: { [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean; nitro?: Record<string, unknown> }) => ({
    nitro: {
      ...config.nitro,
      sandbox: config[VITEHUB_NITRO_CONFIG_CONTEXT],
    },
  })),
  useEnvPlugin: vi.fn(),
  vitehub: vi.fn(),
  workflowNitroConfig: vi.fn(async ({ nitro }: { nitro: Record<string, unknown> }) => ({
    ...nitro,
    workflows: true,
  })),
}))

vi.mock("../src/plugins.ts", async importOriginal => ({ ...await importOriginal<typeof import("../src/plugins.ts")>(), viteHubPlugins: mocks.vitehub }))
vi.mock("../src/internal/optional-owners.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../src/internal/optional-owners.ts")>()
  return { ...original, isPackageInstalled: vi.fn(original.isPackageInstalled) }
})

import { agentInvocationsVitePlugin } from "../src/agent-invocations-vite.ts"
import { consoleVitePlugin } from "../src/console/vite.ts"
import { logsVitePlugin } from "../src/logs-vite.ts"
import viteHubNuxtModule from "../src/nuxt.ts"
import { unavailableServicesPlugin } from "../src/unavailable-services.ts"
import { viteHubTypesPlugin } from "../src/internal/types.ts"
import { optionalOwnerImportsPlugin } from "../src/internal/owner-modules.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"
import { isPackageInstalled } from "../src/internal/optional-owners.ts"
import { hostManagedAuthorize, productionConsole } from "./support/console-authorize.ts"

function createNuxt(dev = false, plugins: PluginOption[] = []) {
  const nitroInitHooks: Array<(instance: { options: { handlers: Array<{ handler: string, route: string, middleware?: boolean }>, output: { serverDir: string } }, hooks: { hook: (name: string, callback: () => Promise<void>) => void } }) => void> = []
  const routerOptionsHooks: Array<(context: { files: Array<{ path: string, optional?: boolean }> }) => void> = []
  const componentsExtendHooks: Array<(components: Array<{ pascalName: string, filePath: string }>) => Promise<void>> = []
  const templatesGeneratedHooks: Array<(app: { components: Array<{ pascalName: string, filePath: string }>, pages?: Array<{ path: string, file: string }>, layouts?: Record<string, { file: string }> }) => Promise<void>> = []
  const builderWatchHooks: Array<(event: string, path: string) => Promise<void>> = []
  const viteServerCreatedHooks: Array<(server: { watcher: { add: (paths: string[]) => void; on: (event: string, callback: (path: string) => void) => void } }, context: { isClient: boolean }) => void> = []
  const closeHooks: Array<() => Promise<void>> = []
  const listenHooks: Array<(server: unknown, listener: { url: string }) => void> = []
  const nitroConfigHooks: Array<(config: Record<string, unknown>) => Promise<void>> = []
  const doctorExtensionHooks: Array<(entries: string[]) => void> = []
  const devtoolsCustomTabsHooks: Array<(tabs: unknown[]) => void> = []
  const iconHooks: Array<(icons: Set<string>) => void> = []
  const modulesDoneHooks: Array<() => void> = []
  const buildBeforeHooks: Array<() => void> = []
  const nuxt = {
    callHook: vi.fn(async (_name: "restart") => {}),
    hook(name: "pages:routerOptions" | "nitro:init" | "components:extend" | "app:templatesGenerated" | "build:before" | "builder:watch" | "close" | "devtools:customTabs" | "doctor:extendExtensions" | "icon:clientBundleIcons" | "listen" | "modules:done" | "nitro:config" | "vite:serverCreated", callback: (typeof routerOptionsHooks)[number] | (typeof nitroInitHooks)[number] | (() => void) | (() => Promise<void>) | ((config: Record<string, unknown>) => Promise<void>) | ((entries: string[]) => void) | ((server: unknown, listener: { url: string }) => void) | ((icons: Set<string>) => void)) {
      if (name === "pages:routerOptions") routerOptionsHooks.push(callback as (typeof routerOptionsHooks)[number])
      else if (name === "nitro:init") nitroInitHooks.push(callback as (typeof nitroInitHooks)[number])
      else if (name === "icon:clientBundleIcons") iconHooks.push(callback as (icons: Set<string>) => void)
      else if (name === "modules:done") modulesDoneHooks.push(callback as () => void)
      else if (name === "build:before") buildBeforeHooks.push(callback as () => void)
      else if (name === "components:extend") componentsExtendHooks.push(callback as (typeof componentsExtendHooks)[number])
      else if (name === "app:templatesGenerated") templatesGeneratedHooks.push(callback as (typeof templatesGeneratedHooks)[number])
      else if (name === "listen") listenHooks.push(callback as (typeof listenHooks)[number])
      else if (name === "devtools:customTabs") devtoolsCustomTabsHooks.push(callback as (tabs: unknown[]) => void)
      else if (name === "doctor:extendExtensions") doctorExtensionHooks.push(callback as (entries: string[]) => void)
      else if (name === "nitro:config") nitroConfigHooks.push(callback as (config: Record<string, unknown>) => Promise<void>)
      else if (name === "builder:watch") builderWatchHooks.push(callback as (event: string, path: string) => Promise<void>)
      else if (name === "vite:serverCreated") viteServerCreatedHooks.push(callback as (typeof viteServerCreatedHooks)[number])
      else if (name === "close") closeHooks.push(callback as () => Promise<void>)
    },
    options: {
      _installedModules: [] as Array<{ meta: { name: string } }>,
      alias: {
        "~": `${tmp}/vitehub-nuxt/app`,
      },
      buildDir: `${tmp}/vitehub-nuxt/.nuxt`,
      dev,
      devServerHandlers: undefined as Array<{
        handler: (event: import("../src/console/runtime/server/request.ts").ConsoleRequestEvent) => void
        route?: string
      }> | undefined,
      modules: undefined as unknown[] | undefined,
      nitro: {} as Record<string, unknown>,
      plugins: [] as Array<string | { src: string }>,
      routeRules: {} as Record<string, { headers?: Record<string, string>; [key: string]: unknown }>,
      router: { options: {} as { sensitive?: boolean, strict?: boolean } },
      rootDir: `${tmp}/vitehub-nuxt`,
      serverDir: `${tmp}/vitehub-nuxt/custom-server` as string | undefined,
      srcDir: `${tmp}/vitehub-nuxt/app`,
      vite: { plugins } as UserConfig,
      vitehubCliDiscovery: undefined as true | undefined,
      watch: undefined as string[] | undefined,
    },
  }
  return {
    routerOptionsHooks,
    templatesGeneratedHooks,
    buildBeforeHooks,
    closeHooks,
    componentsExtendHooks,
    listenHooks,
    nitroConfigHooks,
    nitroInitHooks,
    nuxt,
    viteServerCreatedHooks,
    async runComponentScan(components: Array<{ pascalName: string, filePath: string }>) {
      for (const hook of componentsExtendHooks) await hook(components)
      for (const hook of templatesGeneratedHooks) await hook({ components })
    },
    async runBuilderWatchHook(path = `${tmp}/vitehub-nuxt/console.fixture.json`, event = "change") {
      for (const hook of builderWatchHooks) await hook(event, path)
    },
    async runCloseHook() {
      for (const hook of closeHooks) await hook()
    },
    async runNitroConfigHook(config: Record<string, unknown>) {
      if (!nitroConfigHooks.length) throw new TypeError("Expected a Nitro config hook.")
      for (const hook of nitroConfigHooks) await hook(config)
    },
    runDevToolsCustomTabsHook() {
      const tabs: unknown[] = []
      for (const hook of devtoolsCustomTabsHooks) hook(tabs)
      return tabs
    },
    runIconHook() {
      const icons = new Set<string>()
      for (const hook of iconHooks) hook(icons)
      return icons
    },
    runModulesDoneHook() {
      for (const hook of modulesDoneHooks) hook()
    },
    runDoctorExtensionsHook() {
      const entries: string[] = []
      for (const hook of doctorExtensionHooks) hook(entries)
      return entries
    },
  }
}

/** The Console sections that the generated plugin installs. The standalone Console builds its navigation from them. */
async function generatedConsoleSections(): Promise<string[]> {
  const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
  const sections = /installConsoleSections\("[^"]*", (\[[^\]]*\])/.exec(generated)?.[1]
  if (!sections) throw new TypeError("Expected the generated Console plugin to install sections.")
  // SAFETY: The generated plugin writes the section ids as a JSON string array.
  return JSON.parse(sections) as string[]
}

function nitroOptions(nuxt: ReturnType<typeof createNuxt>["nuxt"]): Record<string, unknown> {
  // SAFETY: createNuxt initializes the Nitro options exercised by these fixtures.
  return (nuxt.options as typeof nuxt.options & { nitro: Record<string, unknown> }).nitro
}

const agentJournalPlugin = `${tmp}/vitehub-nuxt/.vitehub/nitro/agent/invocations.mjs`

/** Reads the Agent Invocations plugin that a Nuxt production build generates. `replay` runs Nuxt's Nitro config hook first. */
async function generatedAgentJournal(application: ReturnType<typeof createNuxt>, replay = false): Promise<string> {
  if (replay) await application.runNitroConfigHook(nitroOptions(application.nuxt))
  return await readFile(agentJournalPlugin, "utf8")
}

function nitroPlugins(nuxt: ReturnType<typeof createNuxt>["nuxt"]): string[] {
  const plugins = nitroOptions(nuxt).plugins
  if (!Array.isArray(plugins) || !plugins.every(plugin => typeof plugin === "string")) {
    throw new TypeError("Expected string-valued Nitro plugins.")
  }
  return plugins
}

function nitroHandlerRoutes(config: Record<string, unknown>): Array<string | undefined> {
  const handlers = config.handlers
  if (!Array.isArray(handlers)) return []
  // SAFETY: These fixtures install Nitro handlers with the route shape asserted below.
  return (handlers as Array<{ route?: string }>).map(handler => handler.route)
}

describe("ViteHub Nuxt integration", () => {
  it.each(["4.6.4", "3.17.0"])("stops on Nuxt %s with a diagnostic that names Nuxt 5", async (version) => {
    const application = createNuxt(false)
    Object.assign(application.nuxt, { _version: version })
    await expect(viteHubNuxtModule({ host: "node" }, application.nuxt)).rejects.toMatchObject({
      code: "VITE_HUB_B0023",
      message: expect.stringContaining(`needs Nuxt 5, which runs Nitro 3 and H3 2. This app runs Nuxt ${version}.`),
    })
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })

  it.each([
    ["the vitehub key", { vitehub: { preset: "cloudflare" } }, {}],
    ["inline options", {}, { preset: "cloudflare" }],
  ])("fails on the renamed preset option in %s", async (_, config, inline) => {
    const application = createNuxt(false)
    Object.assign(application.nuxt.options, config)
    // SAFETY: an old nuxt.config.ts still sets `preset`, which ViteHubNuxtOptions no longer declares.
    await expect(viteHubNuxtModule(inline as Parameters<typeof viteHubNuxtModule>[0], application.nuxt)).rejects.toMatchObject({
      code: "VITE_HUB_B0024",
      message: expect.stringContaining("`preset` in the `vitehub` options of nuxt.config.ts is no longer a ViteHub option."),
    })
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })

  it("sets up on a Nuxt 5 nightly", async () => {
    const application = createNuxt(false)
    Object.assign(application.nuxt, { _version: "5.0.0-2611052317-a04317f" })
    await expect(viteHubNuxtModule({ host: "node" }, application.nuxt)).resolves.toBeUndefined()
    await application.runCloseHook()
  })

  beforeEach(async () => {
    vi.unstubAllEnvs()
    await mkdir(`${tmp}/vitehub-nuxt`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/package.json`, `${JSON.stringify({ name: "vitehub-nuxt" })}\n`)
    await rm(`${tmp}/vitehub-nuxt/app/package.json`, { force: true })
    await rm(`${tmp}/vitehub-nuxt/custom-server`, { force: true, recursive: true })
    mocks.objectHook.mockClear()
    mocks.agentHook.mockClear()
    mocks.agentWorkflowRegistryTransform.mockClear()
    mocks.existingQueueConfig.mockClear()
    mocks.existingQueueNitroConfig.mockClear()
    mocks.existingOwnerConfig.mockClear()
    mocks.envHook.mockClear()
    mocks.outputHook.mockClear()
    mocks.queueNitroConfig.mockClear()
    mocks.sandboxTaskHook.mockClear()
    mocks.useEnvPlugin.mockClear()
    mocks.workflowNitroConfig.mockClear()
    mocks.vitehub.mockReset()
    mocks.vitehub.mockReturnValue([
      false,
      [
        {
          name: "vite-hub/deployment-host",
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
        name: "@vite-hub/sandbox/task/vite",
        config: mocks.sandboxTaskHook,
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
    ])
  })

  it("passes Nuxt's resolved component registry to the retained Comments plugin", async () => {
    const setComponents = vi.fn(async (_components: Array<{ pascalName: string, filePath: string }>) => {})
    const retained = { name: "@vite-hub/comments/vite", api: { setComponents } }
    const unused = vi.fn()
    mocks.vitehub.mockReturnValue([{ name: retained.name, api: { setComponents: unused } }])
    const { nuxt, runComponentScan } = createNuxt(false, [retained])
    await viteHubNuxtModule({ host: "node" }, nuxt)
    expect(setComponents).toHaveBeenCalledWith([])
    const components = [{ pascalName: "CustomCard", filePath: `${tmp}/vitehub-nuxt/widgets/Card.client.vue` }]
    await runComponentScan(components)
    expect(setComponents).toHaveBeenLastCalledWith(components)
    expect(unused).not.toHaveBeenCalled()
  })

  it("writes the final component map after later hooks on initial scans and development rescans", async () => {
    const root = await mkdtemp("/tmp/vitehub-comments-nuxt-")
    try {
      await mkdir(resolve(root, "server"))
      await mkdir(resolve(root, "widgets"))
      await writeFile(resolve(root, "server/comments.ts"), "export const comments = defineComments()")
      await writeFile(resolve(root, "widgets/Card.vue"), "<template />")
      const plugin = hubComments()
      const { nuxt, componentsExtendHooks, runComponentScan } = createNuxt(true, [plugin])
      nuxt.options.rootDir = root
      await viteHubNuxtModule({ host: "node" }, nuxt)
      const config: UserConfig = { root }
      const configure = plugin.config as { handler: (config: UserConfig, env: ConfigEnv) => Promise<void> }
      await configure.handler(config, { command: "serve", mode: "development" })
      let finalName = "InitialCard"
      // A module registered after Comments can rename, remove, and add components asynchronously.
      componentsExtendHooks.push(async (components) => {
        await Promise.resolve()
        components.splice(0, components.length, { pascalName: finalName, filePath: resolve(root, "widgets/Card.vue") })
      })
      const readMap = async () => (await import(`data:text/javascript,${encodeURIComponent(await readFile(resolve(root, ".vitehub/nitro/comments/components.mjs"), "utf8"))}`)).default
      for (const name of ["InitialCard", "RescannedCard"]) {
        finalName = name
        await runComponentScan([{ pascalName: "RemovedCard", filePath: resolve(root, "widgets/Card.vue") }])
        const map = await readMap()
        expect(map[name]).toEqual(["widgets/Card.vue"])
        expect(map).not.toHaveProperty("RemovedCard")
        if (name === "RescannedCard") expect(map).not.toHaveProperty("InitialCard")
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["cloudflare", "vercel"] as const)("retains %s deployment inspection metadata without installing the writer", async (preset) => {
    const { nuxt } = createNuxt()
    nuxt.options.vitehubCliDiscovery = true
    nuxt.options.nitro = { rootDir: "/tmp/nuxt-nitro-root", output: { dir: "custom-output" } }
    await viteHubNuxtModule({ host: preset }, nuxt)
    const entries = await collectViteHubProviderOutputEntries(nuxt.options.vite.plugins ?? [])
    expect(entries).toContainEqual(expect.objectContaining({ owner: "vite-hub", path: "/tmp/nuxt-nitro-root/custom-output/deployment.json" }))
    expect(entries).toContainEqual(expect.objectContaining({ owner: "vite-hub", path: preset === "cloudflare" ? "/tmp/nuxt-nitro-root/custom-output/server/wrangler.json" : "/tmp/nuxt-nitro-root/custom-output/config.json" }))
    expect(nuxt.options.vite.plugins).not.toContainEqual(expect.objectContaining({ name: "vite-hub/deployment-output" }))
  })

  it("registers the ViteHub Doctor Extension entry for vite-doctor/nuxt", async () => {
    const { nuxt, runDoctorExtensionsHook } = createNuxt()
    await viteHubNuxtModule({ host: "node" }, nuxt)
    const entries = runDoctorExtensionsHook()
    expect(entries).toEqual([fileURLToPath(new URL("../src/doctor", import.meta.url))])
    const { default: extension } = await import(`${entries[0]}.ts`)
    expect(extension).toMatchObject({ name: "vite-hub" })
  })

  it("keeps ViteHub discovery rooted at the Nuxt project", async () => {
    const { nuxt } = createNuxt()
    delete nuxt.options.vite.root

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(nuxt.options.vite.root).toBe(nuxt.options.rootDir)
    expect(Reflect.get(nuxt.options.vite, "__vitehubProjectRoot")).toBe(nuxt.options.rootDir)
  })

  it("lets Nitro's dev shim answer cloudflare:workers in nuxt dev, and only there", async () => {
    type External = (id: string, importer: string | undefined, isResolved: boolean) => boolean
    type RollupOptions = { external?: unknown }
    const devPlugin = async (dev: boolean) => {
      const { nuxt, runNitroConfigHook } = createNuxt(dev)
      await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
      // Generated Nitro plugins list the scheme as external for the Worker build.
      const config: Record<string, unknown> = { rollupConfig: { external: ["cloudflare:workers", "node:fs", /^@scope\//] } }
      await runNitroConfigHook(config)
      const plugins = (config.rollupConfig as { plugins?: Array<{ name?: string, options?: (options: RollupOptions) => RollupOptions }> }).plugins
      return plugins?.find(plugin => plugin.name === "vite-hub/nitro-cloudflare-workers-dev")
    }
    expect(await devPlugin(false)).toBeUndefined()
    const plugin = await devPlugin(true)
    expect(plugin).toBeDefined()
    for (const external of [["cloudflare:workers", "node:fs", /^@scope\//], (id: string) => id === "cloudflare:workers" || id === "node:fs" || id.startsWith("@scope/"), undefined]) {
      const result = plugin!.options!({ external }).external as External
      expect(result("cloudflare:workers", undefined, false)).toBe(false)
      expect(result("node:fs", undefined, false)).toBe(external !== undefined)
      expect(result("@scope/x", undefined, false)).toBe(external !== undefined)
      expect(result("vue", undefined, false)).toBe(false)
    }
  })

  it.each([false, true])("resolves unstorage's Cloudflare import during Nitro replay (dev: %s)", async (dev) => {
    mocks.vitehub.mockReturnValue([hubKV({ driver: "cloudflare-kv-binding", binding: "KV" })])
    const { nuxt, runNitroConfigHook } = createNuxt(dev)
    await viteHubNuxtModule({ kv: true, host: "cloudflare" }, nuxt)
    const config: Record<string, unknown> = {}
    await runNitroConfigHook(config)
    const { plugins } = config.rollupConfig as { plugins: Plugin[] }
    const resolver = plugins.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")
    const resolveId = typeof resolver?.resolveId === "function" ? resolver.resolveId : resolver?.resolveId?.handler
    if (!resolveId) throw new TypeError("Expected the Nitro KV resolver.")
    // Rollup supplies isEntry, but no Vite ssr option.
    const resolveImport = (importer: string) => Reflect.apply(resolveId, {}, ["cloudflare:workers", importer, { isEntry: false }])
    const result = await resolveImport("/app/node_modules/unstorage/dist/drivers/cloudflare-kv-binding.mjs")
    if (dev) {
      expect(result).toBeUndefined()
      expect(config.alias).toHaveProperty("cloudflare:workers", expect.stringContaining("cloudflare-workers.dev.mjs"))
    }
    else {
      expect(result).toEqual({ external: true, id: "cloudflare:workers" })
    }
    expect(await resolveImport("/app/server/api/example.ts")).toBeUndefined()
  })

  it("discovers Definitions in every Nuxt layer server directory, application first", async () => {
    const serverDirsHook = vi.fn()
    const { nuxt, runNitroConfigHook } = createNuxt(true, [{ name: "vite-hub/server-dirs", config: serverDirsHook }])
    Object.assign(nuxt.options, {
      _layers: [
        { config: { rootDir: `${tmp}/vitehub-nuxt` }, cwd: `${tmp}/vitehub-nuxt` },
        { config: { rootDir: "/tmp/vitehub-layers/auth", serverDir: "/tmp/vitehub-layers/auth/server" }, cwd: "/tmp/vitehub-layers/auth" },
        { config: { rootDir: "/tmp/vitehub-layers/blog", serverDir: "/tmp/vitehub-layers/blog/server" }, cwd: "/tmp/vitehub-layers/blog" },
      ],
    })
    const serverDirs = [`${tmp}/vitehub-nuxt/custom-server`, "/tmp/vitehub-layers/auth/server", "/tmp/vitehub-layers/blog/server"]

    await viteHubNuxtModule({ host: "node" }, nuxt)
    expect(Reflect.get(nuxt.options.vite, VITEHUB_SERVER_DIRS)).toEqual(serverDirs)

    await runNitroConfigHook(nitroOptions(nuxt))
    expect(serverDirsHook).toHaveBeenCalledWith(expect.objectContaining({ [VITEHUB_SERVER_DIRS]: serverDirs }), expect.anything())
  })

  it.each([false, true])("runs the production build checks of replayed Vite plugins only in a build (prepare: %s)", async (prepare) => {
    mocks.vitehub.mockReturnValue([logsVitePlugin({})])
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options, { _prepare: prepare })
    await viteHubNuxtModule({ console: false, env: false, observability: { logs: true }, host: "cloudflare" }, nuxt)

    const result = runNitroConfigHook({})
    if (prepare) await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toThrow("Production Logs needs an existing source")
  })

  it("references the declarations that replayed Vite plugins write after one Nuxt prepare", async () => {
    await rm(`${tmp}/vitehub-nuxt/.vitehub`, { force: true, recursive: true })
    mocks.vitehub.mockReturnValue([
      hubBlob({ stores: { default: { driver: "fs" }, media: { driver: "fs" } } }),
      viteHubTypesPlugin(),
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options, { _prepare: true })
    await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
    await runNitroConfigHook(nitroOptions(nuxt))

    const aggregate = `${tmp}/vitehub-nuxt/.vitehub/types.d.ts`
    await expect(readFile(aggregate, "utf8")).resolves.toContain('/// <reference path="./types/blob.d.ts" />')
    const entry = `${tmp}/vitehub-nuxt/blob-store-names.mts`
    await writeFile(entry, [
      "import { blob } from \"@vite-hub/blob\"",
      "blob.store(\"media\")",
      "// @ts-expect-error The app configures no `medai` store.",
      "blob.store(\"medai\")",
    ].join("\n"))
    const program = ts.createProgram([entry, aggregate], {
      module: ts.ModuleKind.NodeNext,
      noEmit: true,
      paths: { "@vite-hub/blob": [fileURLToPath(new URL("../../blob/src/index.ts", import.meta.url))] },
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    })
    expect(ts.getPreEmitDiagnostics(program, program.getSourceFile(entry)).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  })

  it.each([false, true])("reports missing facade owners through Nuxt Nitro resolution (dev: %s)", async (dev) => {
    mocks.vitehub.mockReturnValue([optionalOwnerImportsPlugin()])
    const { nuxt, runNitroConfigHook } = createNuxt(dev)
    await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)
    const { plugins } = nitroConfig.rollupConfig as { plugins: Plugin[] }
    const bundleFacade = (source: string) => build({
      bundle: true,
      format: "esm",
      logLevel: "silent",
      packages: "external",
      platform: "node",
      write: false,
      stdin: { contents: `import ${JSON.stringify(source)}`, resolveDir: nuxt.options.rootDir },
      plugins: [{
        name: "nuxt-nitro-optional-owners",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^vite-hub\// }, async (args) => {
            for (const plugin of plugins) {
              const resolveId = typeof plugin.resolveId === "function" ? plugin.resolveId : plugin.resolveId?.handler
              if (!resolveId) continue
              await Reflect.apply(resolveId, {}, [args.path, args.importer, { ssr: true, isEntry: false }])
            }
          })
        },
      }],
    })
    const facades = [
      ["vite-hub/ui", "@vite-hub/ui"],
      ["vite-hub/ui/headless", "@vite-hub/ui"],
      ["vite-hub/ui/styles.css", "@vite-hub/ui"],
      ["vite-hub/presets/babysitter/server", "@vite-hub/presets"],
      ["vite-hub/shell", "@vite-hub/shell"],
      ["vite-hub/shell/workspace", "@vite-hub/shell"],
    ] as const
    const ownerRoots = [...new Set(facades.map(([, owner]) => owner))]
      .map(owner => new URL("./", import.meta.resolve(`${owner}/package.json`)).href)
    // Hide the workspace-installed owners from Node resolution while keeping the real install diagnostic.
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        if (ownerRoots.some(root => resolved.url.startsWith(root))) {
          throw new Error(`Cannot find package '${specifier}'`)
        }
        return resolved
      },
    })
    // The earlier tests found the owners in this process. A new process checks them again.
    forgetPackageChecks()
    onTestFinished(forgetPackageChecks)
    try {
      for (const [source, owner] of facades) {
        await expect(bundleFacade(source)).rejects.toMatchObject({
          errors: [{ detail: { code: "VITE_HUB_R0136" }, text: expect.stringContaining(`pnpm add ${owner}`) }],
        })
      }
      await expect(bundleFacade("vite-hub/queue")).resolves.toBeDefined()
    }
    finally {
      hooks.deregister()
    }
    // The owners are back, as after `pnpm add`. The import that failed now resolves.
    for (const [source] of facades) await expect(bundleFacade(source)).resolves.toBeDefined()
  })

  it("leaves headless UI installations without the styled Nuxt runtime", async () => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@nuxt/ui" || specifier.startsWith("@nuxt/ui/")) throw new Error(`Cannot find package '${specifier}'`)
        return nextResolve(specifier, context)
      },
    })
    forgetPackageChecks()
    try {
      expect(await viteHubNuxtModule.getModuleDependencies()).toEqual({})
      const { nuxt, runIconHook } = createNuxt()
      await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
      expect(nuxt.options.plugins).toEqual([])
      expect([...runIconHook()]).toEqual([])
    }
    finally {
      hooks.deregister()
      forgetPackageChecks()
    }
  })

  it("sees Nuxt UI that the app installed after a Nuxt start that failed before Vite", async () => {
    let hidden = true
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (hidden && (specifier === "@nuxt/ui" || specifier.startsWith("@nuxt/ui/"))) throw new Error(`Cannot find package '${specifier}'`)
        return nextResolve(specifier, context)
      },
    })
    forgetPackageChecks()
    try {
      expect(await viteHubNuxtModule.getModuleDependencies()).toEqual({})
      // The setup fails before Vite starts, so no Vite plugin closes. The developer installs Nuxt UI, and Nuxt reloads.
      const failed = createNuxt()
      failed.nuxt.options.nitro = { preset: "vercel" }
      await expect(viteHubNuxtModule({ console: false, env: false, host: "node" }, failed.nuxt)).rejects.toMatchObject({ code: "VITE_HUB_B0009" })
      hidden = false
      expect(await viteHubNuxtModule.getModuleDependencies()).not.toEqual({})
    }
    finally {
      hooks.deregister()
      forgetPackageChecks()
    }
  })

  it("skips the styled runtime when Nuxt UI is installed but its module is not enabled", async () => {
    const { componentsExtendHooks, nuxt, runIconHook, runModulesDoneHook } = createNuxt()
    await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
    runModulesDoneHook()
    expect(nuxt.options.plugins).toEqual([])
    expect([...runIconHook()]).toEqual([])
    const components: Array<{ pascalName: string, filePath: string }> = []
    for (const hook of componentsExtendHooks) await hook(components)
    expect(components).toEqual([])
  })

  it("registers the vitehub Nuxt Image provider for a served Blob Store", async () => {
    const options = (blob: BlobOptions, modules: unknown[] = ["vite-hub/nuxt", ["@nuxt/image", {}]]) => ({ options: { modules, vitehub: { blob } } })
    const served: BlobOptions = { driver: "fs", serve: { access: "public", publicBaseUrl: "https://cdn.example/", route: "/media/" }, images: { sizes: [320, 960] } }
    expect(await viteHubNuxtModule.getModuleDependencies(options(served))).toMatchObject({
      "@nuxt/image": {
        optional: true,
        defaults: { providers: { vitehub: { options: { baseURL: "https://cdn.example/media", imageSizes: [320, 960] }, provider: "vite-hub/blob/nuxt-image" } } },
      },
    })
    expect(await viteHubNuxtModule.getModuleDependencies(options({ driver: "fs", serve: { access: "public" } }))).toMatchObject({
      "@nuxt/image": { defaults: { providers: { vitehub: { options: { baseURL: "/api/_vitehub/blob" } } } } },
    })
    // No served store, or no Nuxt Image module: Nuxt must not try to resolve @nuxt/image.
    expect(await viteHubNuxtModule.getModuleDependencies(options({ driver: "fs" }))).not.toHaveProperty("@nuxt/image")
    expect(await viteHubNuxtModule.getModuleDependencies(options(served, ["vite-hub/nuxt"]))).not.toHaveProperty("@nuxt/image")
  })

  it("registers the ViteHub Iconify collection before Nuxt Icon setup", async () => {
    const dependencies = await viteHubNuxtModule.getModuleDependencies()
    expect(dependencies).toMatchObject({
      "@nuxt/icon": {
        optional: true,
        defaults: {
          customCollections: [expect.objectContaining({
            prefix: "vitehub",
            icons: expect.objectContaining({ kv: expect.objectContaining({ body: expect.any(String) }) }),
          })],
        },
      },
    })
  })

  it.each([["node", true], ["cloudflare", false]] as const)("gives Nuxt Content the Postgres Database on %s: %s", async (host, mapped) => {
    const rootDir = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-content-"))
    onTestFinished(() => rm(rootDir, { force: true, recursive: true }))
    await mkdir(resolve(rootDir, "server/databases"), { recursive: true })
    await writeFile(resolve(rootDir, "package.json"), '{"private":true,"type":"module"}')
    await writeFile(resolve(rootDir, "server/databases/default.ts"), "export default defineDatabase({ dialect: 'postgresql', connection: { url: process.env.DATABASE_URL }, schema: {} })\n")
    const nuxt = { options: { dev: false, modules: ["@nuxt/content"], rootDir, vitehub: { database: true, host } } }
    const dependencies = await viteHubNuxtModule.getModuleDependencies(nuxt)
    expect(dependencies["@nuxt/content"]).toEqual(mapped ? { defaults: { database: { type: "postgresql", url: "" } } } : undefined)
  })

  it.each([false, true])("gives the vite-hub/ui parts their Nuxt runtime, icons, and auto-imports when Nuxt UI installs later: %s", async (later) => {
    const { componentsExtendHooks, nuxt, runIconHook, runModulesDoneHook } = createNuxt()
    if (!later) nuxt.options._installedModules.push({ meta: { name: "@nuxt/ui" } })
    await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
    await viteHubNuxtModule({ console: false, env: false, host: "node" }, nuxt)
    if (later) nuxt.options._installedModules.push({ meta: { name: "@nuxt/ui" } })
    runModulesDoneHook()
    const runtime = nuxt.options.plugins.filter(plugin => String(typeof plugin === "string" ? plugin : plugin.src).endsWith("/ui/dist/runtime/nuxt-plugin.js"))
    expect(runtime).toHaveLength(1)
    // Two module calls still register each component once, from the package's styled entry.
    const components: Array<{ pascalName: string, filePath: string, export?: string }> = []
    for (const hook of componentsExtendHooks) await hook(components)
    expect(components.filter(component => component.pascalName === "Chat")).toEqual([
      expect.objectContaining({ export: "Chat", filePath: expect.stringMatching(/\/ui\/dist\/index\.js$/) }),
    ])
    // The list that @vite-hub/ui generates from the icons its sources name, so a new icon of a part needs no change here.
    expect([...runIconHook()].sort()).toEqual([...viteHubUIIcons].sort())
    expect(viteHubUIIcons).toEqual(expect.arrayContaining(["lucide:arrow-left", "lucide:check", "lucide:pencil", "lucide:trash-2", "lucide:x"]))
  })

  it("installs the Email resolver for Nitro Console output", async () => {
    const defaultPlugins = mocks.vitehub()
    const resolveId = vi.fn(function(this: unknown, id: string) {
      if (id === "#vitehub/email/definition") return "\0vitehub-test-email-definition"
    })
    const load = vi.fn(function(this: unknown, id: string) {
      if (id === "\0vitehub-test-email-definition") return "export const outboxRuntimeId = 'email resolver reached'"
    })
    mocks.vitehub.mockReturnValueOnce([
      defaultPlugins,
      {
        name: "@vite-hub/email/vite",
        resolveId,
        load,
      },
    ])
    const development = createNuxt(true)
    await viteHubNuxtModule({ console: { auth: false }, email: true, host: "node" }, development.nuxt)
    const nitroConfig = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(nitroConfig)
    const rollupConfig = nitroConfig.rollupConfig as { plugins?: Plugin[] }
    const resolver = rollupConfig.plugins?.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/email/vite")
    if (!resolver || typeof resolver.resolveId !== "function" || typeof resolver.load !== "function") {
      throw new TypeError("Expected Nitro Email resolver hooks.")
    }
    if (typeof resolver.resolveId !== "function" || typeof resolver.load !== "function") {
      throw new TypeError("Expected callable Nitro Email resolver hooks.")
    }
    const hooks = resolver as unknown as {
      resolveId: (this: unknown, id: string, importer: string | undefined, options: { ssr: boolean; isEntry: boolean }) => unknown
      load: (this: unknown, id: string) => unknown
    }
    const hookContext = { marker: "email-resolver-context" }
    const importer = `${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`
    const options = { ssr: true, isEntry: false }
    const resolved = await hooks.resolveId.call(hookContext, "#vitehub/email/definition", importer, options)
    expect(resolved).toBe("\0vitehub-test-email-definition")
    expect(resolveId).toHaveBeenCalledWith("#vitehub/email/definition", importer, options)
    expect(resolveId.mock.instances.at(-1)).toBe(hookContext)
    expect(await hooks.load.call(hookContext, String(resolved))).toContain("email resolver reached")
    expect(load).toHaveBeenCalledWith(String(resolved), { ssr: true })
    expect(load.mock.instances.at(-1)).toBe(hookContext)
    const generatedPlugin = `${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`
    // The Email owner contributes its Console reader by file path.
    expect(await readFile(generatedPlugin, "utf8"))
      .toMatch(/[\\/]email[\\/](?:src|dist)[\\/]runtime[\\/]console\.(?:ts|js)"/)
    const result = await build({
      bundle: true,
      entryPoints: [generatedPlugin],
      format: "esm",
      packages: "external",
      platform: "node",
      write: false,
      plugins: [{
        name: "nitro-email-resolver-test",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^#vitehub\/email\/definition$/ }, async args => ({
            path: String(await hooks.resolveId.call({}, args.path, undefined, { ssr: false, isEntry: false })),
            namespace: "nitro-email",
          }))
          pluginBuild.onLoad({ filter: /.*/, namespace: "nitro-email" }, async args => ({
            contents: String(await hooks.load.call({}, args.path)),
            loader: "js",
          }))
        },
      }],
    })
    expect(result.outputFiles?.[0]?.text).toContain("installConsoleDefinitions")
  })

  it.each([false, true])("bundles facade, owner, and generated imports through Nitro runtime aliases (dev: %s)", async (dev) => {
    const { nuxt, runNitroConfigHook } = createNuxt(dev)
    const noExternals = ["existing-inline"]
    const nitroConfig: { noExternals: unknown } = { noExternals }

    await viteHubNuxtModule({ host: "node", blob: true, kv: true, database: true }, nuxt)
    await runNitroConfigHook(nitroConfig)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig.noExternals).toEqual(["existing-inline", "vite-hub", "@vite-hub/", `${tmp}/vitehub-nuxt/.vitehub`, h3RuntimeRoot])
    expect(noExternals).toEqual(["existing-inline"])
  })

  it.each([false, true])("bundles linked workspace packages through Nitro runtime aliases (dev: %s)", async (dev) => {
    const { nuxt, runNitroConfigHook } = createNuxt(dev)
    const nodeModules = resolve(nuxt.options.rootDir, "node_modules")
    const frameworkRoot = resolve(tmp, "linked-framework")
    const authRoot = resolve(tmp, "linked-auth")
    const installedRoot = resolve(nodeModules, ".pnpm/kv")
    try {
      for (const directory of [resolve(nodeModules, "@vite-hub"), frameworkRoot, authRoot, installedRoot]) {
        await mkdir(directory, { recursive: true })
      }
      await symlink(frameworkRoot, resolve(nodeModules, "vite-hub"), "junction")
      await symlink(authRoot, resolve(nodeModules, "@vite-hub/auth"), "junction")
      await symlink(installedRoot, resolve(nodeModules, "@vite-hub/kv"), "junction")
      const nitroConfig: Record<string, unknown> = {}
      await viteHubNuxtModule({ console: false }, nuxt)
      await runNitroConfigHook(nitroConfig)
      await runNitroConfigHook(nitroConfig)
      expect(nitroConfig.noExternals).toEqual(["vite-hub", "@vite-hub/", resolve(nuxt.options.rootDir, ".vitehub"), h3RuntimeRoot, frameworkRoot, authRoot])
    }
    finally {
      await rm(nodeModules, { recursive: true, force: true })
    }
  })

  it("loads mode-specific KV credentials only in Nitro's server replay", async () => {
    const envDir = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-kv-env-"))
    for (const name of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) vi.stubEnv(name, undefined)
    await writeFile(resolve(envDir, ".env.development"), "KV_REST_API_URL=https://nuxt-kv.test\nKV_REST_API_TOKEN=nuxt-kv-secret\n")
    const plugin = hubKV({ remote: true })
    mocks.vitehub.mockReturnValue([plugin])
    const { nuxt, runNitroConfigHook } = createNuxt(true)
    nuxt.options.vite.envDir = envDir
    try {
      await viteHubNuxtModule({ kv: true, host: "node" }, nuxt)
      const config: Record<string, unknown> = {}
      await runNitroConfigHook(config)
      const { plugins } = config.rollupConfig as { plugins: Plugin[] }
      const resolver = plugins.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")
      const load = typeof resolver?.load === "function" ? resolver.load : resolver?.load?.handler
      if (!load) throw new TypeError("Expected the Nitro KV load hook.")
      const module = await Reflect.apply(load, {}, ["\0#vitehub/kv/config"])
      expect(module).toContain("https://nuxt-kv.test")
      expect(module).toContain("nuxt-kv-secret")
      expect(JSON.stringify(plugin.api.getConfig())).not.toContain("nuxt-kv-secret")
      const clientLoad = typeof plugin.load === "function" ? plugin.load : plugin.load!.handler
      expect(await Reflect.apply(clientLoad, {}, ["\0#vitehub/kv/config", { ssr: false }])).not.toContain("nuxt-kv-secret")
      expect(process.env.KV_REST_API_TOKEN).toBeUndefined()
    }
    finally {
      vi.unstubAllEnvs()
      await rm(envDir, { force: true, recursive: true })
    }
  })

  it("registers Content KV when Nuxt 5 builds Nitro 3 without a Vite environment", async () => {
    const content = hubContent()
    mocks.vitehub.mockReturnValue([content, hubKV(undefined, { hosting: "node" })])
    const { nuxt, runNitroConfigHook } = createNuxt(false)
    Object.assign(nuxt.options, { experimental: { nitroViteEnvironment: false } })
    const file = resolve(nuxt.options.serverDir!, "content.ts")
    await mkdir(nuxt.options.serverDir!, { recursive: true })
    await writeFile(file, "export default {}")
    await viteHubNuxtModule({ kv: true, host: "node" }, nuxt)
    const config: Record<string, unknown> = {}
    await runNitroConfigHook(config)
    const modules = config.modules as Array<typeof content.nitro>
    const module = modules.find(candidate => candidate.name === content.nitro.name)
    expect(module).toBeDefined()
    const options = { rollupConfig: { plugins: [] as Plugin[] } }
    module!.setup({ options })
    const plugin = options.rollupConfig.plugins.find(candidate => candidate.name === "@vite-hub/content/nitro-kv")!
    const transform = typeof plugin.transform === "function" ? plugin.transform : plugin.transform!.handler
    expect(await Reflect.apply(transform, {}, ["export default {}", file])).toMatchObject({ code: expect.stringContaining("__vitehubRegisterContentKV(__vitehubContentKV, ") })
  })

  it.each(["application", "layer", "contribution"])("infers Postgres KV from a %s Database when Nuxt skips the Vite build", async (source) => {
    const plugin = hubKV(undefined, { databaseImport: "@vite-hub/database/runtime/registry", hosting: "node" })
    mocks.vitehub.mockReturnValue([plugin])
    const { nuxt, runNitroConfigHook } = createNuxt(false)
    Object.assign(nuxt.options, { experimental: { nitroViteEnvironment: false } })
    const root = await mkdtemp(resolve(tmp, "kv-database-"))
    const directory = source === "application" ? resolve(nuxt.options.serverDir!, "databases") : resolve(root, "server/databases")
    await mkdir(directory, { recursive: true })
    const definition = resolve(directory, "default.ts")
    await writeFile(definition, `import { defineDatabase } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@vite-hub/database")))}\nexport default defineDatabase({ dialect: "postgresql", schema: {} })`)
    if (source === "layer") Object.assign(nuxt.options, { _layers: [{ config: { rootDir: root }, cwd: root }] })
    if (source === "contribution") nuxt.options.vite.plugins!.push({
      name: "test/database-contribution",
      vitehub: { databases: [{ name: "default", definition }] },
    } as Plugin)

    try {
      await viteHubNuxtModule({ database: true, kv: true, host: "node" }, nuxt)
      const database = (nuxt.options.vite.plugins as Plugin[]).find(candidate => candidate.name === "@vite-hub/database/vite")
      expect(database?.api.getConfig()).toBeUndefined()
      const config: Record<string, unknown> = {}
      // A cache hit goes straight to separate Nitro bundling: no Vite configResolved or buildStart.
      await runNitroConfigHook(config)
      const { plugins } = config.rollupConfig as { plugins: Plugin[] }
      const resolver = plugins.find(candidate => candidate.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")
      const load = typeof resolver?.load === "function" ? resolver.load : resolver?.load?.handler
      if (!load) throw new TypeError("Expected the Nitro KV load hook.")
      const output = await Reflect.apply(load, {}, ["\0#vitehub/kv/config"])
      expect(output).toContain('"driver":"database"')
      expect(output).toContain('export const loadDatabases = () => import("@vite-hub/database/runtime/registry").then(module => module.databases);')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("resolves Blob and KV virtual runtime modules during Nitro bundling", async () => {
    let resolvedKv: unknown
    let resolvedBlob: unknown
    const kvResolveId = vi.fn((id: string) => id === "#vitehub/kv/config" ? "\0#vitehub/kv/config" : undefined)
    const kvLoad = vi.fn((id: string) => id === "\0#vitehub/kv/config" ? `export const kv = ${JSON.stringify(resolvedKv)}` : undefined)
    const blobResolveId = vi.fn((id: string) => id === "#vitehub/blob/config" ? "\0#vitehub/blob/config" : undefined)
    const blobLoad = vi.fn((id: string) => id === "\0#vitehub/blob/config" ? `export const blob = ${JSON.stringify(resolvedBlob)}` : undefined)
    mocks.vitehub.mockReturnValue([
      {
        configResolved(config: { kv?: unknown }) {
          resolvedKv = config.kv
        },
        load: kvLoad,
        name: "@vite-hub/kv/vite",
        resolveId: kvResolveId,
      },
      {
        configResolved(config: { blob?: unknown }) {
          resolvedBlob = config.blob
        },
        load: blobLoad,
        name: "@vite-hub/blob/vite",
        resolveId: blobResolveId,
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      blob: { driver: "r2" },
      kv: { binding: "KV", driver: "cloudflare-kv-binding" },
    })
    const existingPlugin: Plugin = { name: "existing-nitro-plugin" }
    const nitroConfig: { rollupConfig: { plugins: Plugin } } = {
      rollupConfig: { plugins: existingPlugin },
    }

    await viteHubNuxtModule({ blob: true, kv: true, host: "cloudflare" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    const plugins = nitroConfig.rollupConfig.plugins as unknown as Plugin[]
    expect(plugins.map(plugin => plugin.name)).toEqual([
      "vite-hub/console-operation-features",
      "vite-hub/nitro-optional-peers",
      "vite-hub/nitro-h3",
      "vite-hub/nitro-cache-bypass",
      "existing-nitro-plugin",
      "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite",
      "vite-hub/nuxt-runtime-resolver:@vite-hub/blob/vite",
    ])
    const kvResolver = plugins.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")!
    const blobResolver = plugins.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/blob/vite")!
    const context = { marker: "nitro-context" }
    expect(Reflect.apply(kvResolver.resolveId as Function, context, ["#vitehub/kv/config"])).toBe("\0#vitehub/kv/config")
    expect(Reflect.apply(kvResolver.load as Function, context, ["\0#vitehub/kv/config"])).toBe(
      'export const kv = {"binding":"KV","driver":"cloudflare-kv-binding"}',
    )
    expect(Reflect.apply(blobResolver.resolveId as Function, context, ["#vitehub/blob/config"])).toBe("\0#vitehub/blob/config")
    expect(Reflect.apply(blobResolver.load as Function, context, ["\0#vitehub/blob/config"])).toBe(
      'export const blob = {"driver":"r2"}',
    )
    expect(kvResolveId.mock.contexts[0]).toBe(context)
    expect(kvLoad.mock.contexts[0]).toBe(context)
    expect(kvLoad).toHaveBeenCalledWith("\0#vitehub/kv/config", { ssr: true })
    expect(blobLoad).toHaveBeenCalledWith("\0#vitehub/blob/config", { ssr: true })
    expect(blobResolveId.mock.contexts[0]).toBe(context)
    expect(blobLoad.mock.contexts[0]).toBe(context)
  })

  it("keeps the hook filters of replayed Nitro resolvers", async () => {
    const filter = { id: /^\0?#vitehub\/kv\/config$/ }
    mocks.vitehub.mockReturnValue([{
      load: { filter, handler: () => "export const kv = {}" },
      name: "@vite-hub/kv/vite",
      resolveId: { filter, handler: () => "\0#vitehub/kv/config" },
    }])
    const { nuxt, runNitroConfigHook } = createNuxt()
    await viteHubNuxtModule({ kv: true }, nuxt)
    const config: { rollupConfig?: { plugins?: Plugin[] } } = {}
    await runNitroConfigHook(config)

    const resolver = config.rollupConfig?.plugins?.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")
    expect(resolver?.resolveId).toEqual({ filter, handler: expect.any(Function) })
    expect(resolver?.load).toEqual({ filter, handler: expect.any(Function) })
  })

  it("does not replay runtime resolvers when Nuxt builds Nitro in a Vite environment", async () => {
    const owner = hubAgent()
    mocks.vitehub.mockReturnValue([
      { load: () => undefined, name: "@vite-hub/kv/vite", resolveId: () => undefined },
      { name: owner.name, vitehub: { agent: owner.vitehub?.agent } },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options, { experimental: { nitroViteEnvironment: true } })
    await viteHubNuxtModule({ kv: true }, nuxt)
    const config: { rollupConfig?: { plugins?: Plugin[] } } = {}
    await runNitroConfigHook(config)

    expect(config.rollupConfig?.plugins?.map(plugin => plugin.name)).not.toContain("vite-hub/nuxt-runtime-resolver:@vite-hub/kv/vite")
    expect(config.rollupConfig?.plugins?.map(plugin => plugin.name)).not.toContain("vite-hub/nuxt-runtime-resolver:@vite-hub/agent/vite")
  })

  it("checks direct folder Agent imports before the catalog loads in Nuxt 5's separate Nitro 3 build", async () => {
    const root = await mkdtemp(resolve(import.meta.dirname, ".nuxt-agent-workspace-"))
    try {
      const builderRoot = "node_modules/nuxt/node_modules/@nuxt/nitro-server"
      for (const [directory, manifest] of [
        ["node_modules/nuxt", { name: "nuxt", version: "5.0.0", dependencies: { "@nuxt/nitro-server": "5.0.0" } }],
        [builderRoot, { name: "@nuxt/nitro-server", dependencies: { nitro: "3.0.261102-rc" } }],
        [`${builderRoot}/node_modules/nitro`, { name: "nitro", version: "3.0.261102-rc" }],
      ] as const) {
        await mkdir(resolve(root, directory), { recursive: true })
        await writeFile(resolve(root, directory, "package.json"), JSON.stringify(manifest))
      }
      const owner = hubAgent()
      mocks.vitehub.mockReturnValue([{ name: owner.name, vitehub: { agent: owner.vitehub?.agent } }])
      const { nuxt, runNitroConfigHook } = createNuxt()
      Object.assign(nuxt.options, {
        rootDir: root,
        srcDir: resolve(root, "app"),
        serverDir: resolve(root, "custom-server"),
        buildDir: resolve(root, ".nuxt"),
        experimental: { nitroViteEnvironment: false },
      })
      await viteHubNuxtModule({ agent: true, host: "node" }, nuxt)
      const config: { rollupConfig?: { plugins?: Plugin[] } } = {}
      await runNitroConfigHook(config)
      const resolver = config.rollupConfig?.plugins?.find(plugin => plugin.name === "vite-hub/nuxt-runtime-resolver:@vite-hub/agent/vite")
      const transform = typeof resolver?.transform === "function" ? resolver.transform : resolver?.transform?.handler
      if (!transform) throw new TypeError("Expected the Nitro Agent transform hook.")

      const sources = {
        review: "export default defineAgent({ channels: { github: github({ pullRequest: true }) }, driver: { run: () => 'ok' } })",
        declared: "export default defineAgent({ workspace: {}, channels: { github: github({ pullRequest: true }) }, driver: { run: () => 'ok' } })",
        dynamic: "const options = () => ({ workspace: {}, driver: { run: () => 'ok' } })\nexport default defineAgent(options())",
        plain: "export default defineAgent({ driver: { run: () => 'ok' } })",
        flat: "export default defineAgent({ channels: { github: github({ pullRequest: true }) }, driver: { run: () => 'ok' } })",
      }
      for (const [name, body] of Object.entries(sources)) {
        const file = resolve(root, "custom-server/agents", name === "flat" ? "flat.ts" : `${name}/agent.ts`)
        const source = `import { defineAgent } from '@vite-hub/agent'\nimport { github } from '@vite-hub/agent/channels'\n${body}`
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, source)
        const transformed = await Reflect.apply(transform, {}, [source, file])
        const artifact = resolve(root, `${name}.mjs`)
        // Compile the direct import without loading the generated catalog or running any Vite plugin.
        await build({ stdin: { contents: transformed ?? source, loader: "ts", resolveDir: dirname(file) }, outfile: artifact, format: "esm" })
        const loaded = import(/* @vite-ignore */ pathToFileURL(artifact).href)
        if (name === "review") await expect(loaded).rejects.toMatchObject({ code: "AGENT_R1037" })
        else expect((await loaded).default).toBeDefined()
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { dev: false, enabled: true },
    { dev: true, enabled: true },
    { dev: false, enabled: false },
    { dev: true, enabled: false },
  ])("bundles service availability through Nuxt Nitro (dev: $dev, enabled: $enabled)", async ({ dev, enabled }) => {
    const root = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-availability-"))
    try {
      await mkdir(resolve(root, "server/realtime"), { recursive: true })
      await writeFile(resolve(root, "server/realtime/docs.ts"), "export default {}\n")
      const preset = enabled ? "cloudflare" : "node"
      mocks.vitehub.mockReturnValue([
        // Directly composed owners must override the disabled provider after replay.
        unavailableServicesPlugin(resolveDeploymentPlan(preset), { browser: false, realtime: false }),
        ...enabled ? [hubBrowser(), hubRealtime()] : [],
      ])
      const { nuxt, runNitroConfigHook } = createNuxt(dev)
      Object.assign(nuxt.options, {
        rootDir: root,
        srcDir: root,
        serverDir: resolve(root, "server"),
        buildDir: resolve(root, ".nuxt"),
      })
      const nitroConfig: Record<string, unknown> = { preset }
      await viteHubNuxtModule({ console: false, env: false, host: preset }, nuxt)
      await runNitroConfigHook(nitroConfig)
      const { plugins } = nitroConfig.rollupConfig as { plugins: Plugin[] }
      const result = await build({
        bundle: true,
        format: "esm",
        platform: "node",
        write: false,
        stdin: {
          contents: [
            'import browser from "#vitehub/browser/availability"',
            'import realtime from "#vitehub/realtime/availability"',
            "export default { browser, realtime }",
          ].join("\n"),
          resolveDir: root,
        },
        plugins: [{
          name: "nuxt-nitro-availability",
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^#vitehub\/(browser|realtime)\/availability$/ }, async (args) => {
              for (const plugin of plugins) {
                const resolveId = typeof plugin.resolveId === "function" ? plugin.resolveId : plugin.resolveId?.handler
                if (!resolveId) continue
                const id = await Reflect.apply(resolveId, {}, [args.path, undefined, { ssr: true, isEntry: false }])
                if (typeof id === "string") return { path: id, namespace: "availability" }
              }
            })
            pluginBuild.onLoad({ filter: /.*/, namespace: "availability" }, async (args) => {
              for (const plugin of plugins) {
                const load = typeof plugin.load === "function" ? plugin.load : plugin.load?.handler
                if (!load) continue
                const contents = await Reflect.apply(load, {}, [args.path])
                if (typeof contents === "string") return { contents, loader: "js" }
              }
            })
          },
        }],
      })
      const { default: availability } = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0]!.text)}`)
      expect(availability).toMatchObject({ browser: { available: enabled }, realtime: { available: enabled } })
      if (!enabled) {
        expect(availability.browser).toMatchObject({
          host: "node",
          reason: "The Node host has no built-in Browser Provider.",
          fix: "Deploy with the Cloudflare host and set `browser: true` in vitehub().",
        })
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("gives the Console's KV operations a disabled config and Upstash stub when KV is off", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig: Record<string, unknown> = {}

    await viteHubNuxtModule({ comments: false, console: productionConsole, host: "cloudflare" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    const kvConfig = (nitroConfig.virtual as Record<string, string> | undefined)?.["#vitehub/kv/config"]
    expect(kvConfig).toBeTypeOf("string")
    const kvAlias = (nitroConfig.alias as Record<string, string>)["#vitehub/kv/config"]!
    expect(await readFile(kvAlias, "utf8")).toBe(kvConfig)
    const bundled = await build({
      alias: { "#vitehub/kv/config": kvAlias },
      bundle: true,
      stdin: { contents: 'export { kv } from "#vitehub/kv/config"', resolveDir: nuxt.options.rootDir },
      write: false,
    })
    expect(bundled.outputFiles[0]?.text).toContain("kv = false")
    // The same exports as the module that @vite-hub/kv/vite generates.
    const kvConfigModule = await import(`data:text/javascript,${encodeURIComponent(kvConfig!)}`) as Record<string, unknown>
    expect({ ...kvConfigModule }).toEqual({ default: { hosting: undefined, kv: false }, hosting: undefined, kv: false })
    // The alias names a real module, the stub that throws only when an Upstash store is used.
    const stub = (nitroConfig.alias as Record<string, string>)["@vite-hub/kv/runtime/upstash-driver"]!
    const { default: upstashDriver } = await import(pathToFileURL(stub).href) as { default: () => never }
    expect(() => upstashDriver()).toThrow(expect.objectContaining({ code: "VITE_HUB_R0001" }))
  })

  it("installs the disabled KV config in development too, and keeps the app's own config and alias", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(true)
    const nitroConfig: Record<string, unknown> = {
      alias: { "@vite-hub/kv/runtime/upstash-driver": "/app/upstash.mjs" },
      virtual: { "#vitehub/kv/config": "export const kv = { custom: true }" },
    }

    await viteHubNuxtModule({ console: { auth: false }, host: "cloudflare" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      alias: { "@vite-hub/kv/runtime/upstash-driver": "/app/upstash.mjs" },
      virtual: { "#vitehub/kv/config": "export const kv = { custom: true }" },
    })
    expect(nitroConfig.alias).not.toHaveProperty("#vitehub/kv/config")

    const fresh = createNuxt(true)
    const freshConfig: Record<string, unknown> = {}
    await viteHubNuxtModule({ console: { auth: false }, host: "cloudflare" }, fresh.nuxt)
    await fresh.runNitroConfigHook(freshConfig)
    expect(freshConfig).toHaveProperty(["virtual", "#vitehub/kv/config"], expect.stringContaining("export const kv = false"))
  })

  it("stubs the Upstash driver for a KV store on another driver and keeps the KV plugin's config", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(false, [{
      name: "@vite-hub/kv/vite",
      api: { getConfig: () => ({ kv: { store: { binding: "KV", driver: "cloudflare-kv-binding" as const } } }) },
    }])
    const nitroConfig: Record<string, unknown> = {}

    await viteHubNuxtModule({ comments: false, console: productionConsole, kv: true, host: "cloudflare" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect((nitroConfig.virtual as Record<string, string> | undefined)?.["#vitehub/kv/config"]).toBeUndefined()
    expect((nitroConfig.alias as Record<string, string>)["@vite-hub/kv/runtime/upstash-driver"]).toMatch(/[\\/]internal[\\/]disabled-upstash-driver\.(?:ts|js)$/)
  })

  it("keeps the Upstash driver for an Upstash KV store", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(false, [{
      name: "@vite-hub/kv/vite",
      api: { getConfig: () => ({ kv: { store: { driver: "upstash" as const, url: "https://kv.example.com", token: "token" } } }) },
    }])
    const nitroConfig: Record<string, unknown> = {}

    await viteHubNuxtModule({ comments: false, console: productionConsole, kv: true, host: "cloudflare" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect((nitroConfig.alias as Record<string, string> | undefined)?.["@vite-hub/kv/runtime/upstash-driver"]).toBeUndefined()
  })

  it("installs Nitro modules owned by replayed ViteHub plugins", async () => {
    const setup = vi.fn()
    const nitroModule = { name: "@vite-hub/sandbox/task/provider-runtime", setup }
    mocks.vitehub.mockReturnValue([{
      name: "@vite-hub/sandbox/task/vite",
      nitro: nitroModule,
    }])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const existingModule = { name: "existing-module", setup: vi.fn() }
    const nitroConfig: Record<string, unknown> = { modules: existingModule }

    await viteHubNuxtModule({ host: "cloudflare", sandboxTask: true }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig.modules).toEqual([existingModule, nitroModule])
  })

  it.each([false, true])("starts a bundle session before each Nuxt production build (retained plugin: %s)", async (retained) => {
    const startBuild = vi.fn()
    const nitroModule = { name: "@vite-hub/bundle/nitro", setup: vi.fn() }
    const plugin = {
      name: "@vite-hub/bundle/vite",
      api: { startBuild },
      nitro: nitroModule,
    }
    mocks.vitehub.mockReturnValue([{ ...plugin, api: { startBuild: retained ? vi.fn() : startBuild } }])
    const { nuxt, buildBeforeHooks, runNitroConfigHook } = createNuxt(false, retained ? [plugin] : [])
    await viteHubNuxtModule({ bundle: true, host: "cloudflare" }, nuxt)
    const config: Record<string, unknown> = {}
    await runNitroConfigHook(config)
    expect(config.modules).toContain(nitroModule)
    expect(startBuild).not.toHaveBeenCalled()
    expect(buildBeforeHooks).toHaveLength(1)
    for (const hook of buildBeforeHooks) hook()
    for (const hook of buildBeforeHooks) hook()
    expect(startBuild).toHaveBeenCalledTimes(2)
  })

  it("captures Nuxt route matching defaults and configured options", async () => {
    const setRoutes = vi.fn()
    mocks.vitehub.mockReturnValue([{ name: "@vite-hub/bundle/vite", api: { startBuild: vi.fn(), setRoutes } }])
    const { nuxt, routerOptionsHooks, templatesGeneratedHooks } = createNuxt(false)
    await viteHubNuxtModule({ bundle: true }, nuxt)
    const context = { files: [{ path: "nuxt/pages/runtime/router.options", optional: true }] }
    for (const hook of routerOptionsHooks) hook(context)
    const app = { components: [], pages: [{ path: "/Docs", file: "/app/pages/docs.vue" }] }
    for (const hook of templatesGeneratedHooks) await hook(app)
    expect(setRoutes).toHaveBeenLastCalledWith([{ path: "/Docs", files: ["/app/pages/docs.vue"] }], { sensitive: true, strict: false })
    nuxt.options.router.options = { sensitive: false, strict: true }
    for (const hook of templatesGeneratedHooks) await hook(app)
    expect(setRoutes).toHaveBeenLastCalledWith(expect.any(Array), { sensitive: false, strict: true })
    // A later module may add a router file after our pages:routerOptions callback.
    context.files.push({ path: "/app/router.options.ts", optional: false })
    for (const hook of templatesGeneratedHooks) await hook(app)
    expect(setRoutes).toHaveBeenLastCalledWith([], {
      sensitive: false, strict: true,
      unavailable: "Custom router options (/app/router.options.ts) can change routes or matching at runtime.",
    })
  })

  it("passes the resolved NuxtLayout renderer to bundle route capture", async () => {
    const setRoutes = vi.fn()
    mocks.vitehub.mockReturnValue([{ name: "@vite-hub/bundle/vite", api: { startBuild: vi.fn(), setRoutes } }])
    const { nuxt, templatesGeneratedHooks } = createNuxt(false)
    await viteHubNuxtModule({ bundle: true }, nuxt)
    const app = {
      components: [{ pascalName: "NuxtLayout", filePath: "/nuxt/nuxt-layout.js" }],
      pages: [{ path: "/", file: "/app/pages/index.vue" }],
      layouts: { default: { file: "/app/layouts/default.vue" } },
    }
    for (const hook of templatesGeneratedHooks) await hook(app)
    expect(setRoutes).toHaveBeenLastCalledWith([{
      path: "/", files: ["/app/layouts/default.vue", "/app/pages/index.vue"],
      layout: { file: "/app/layouts/default.vue", component: "/nuxt/nuxt-layout.js" },
    }], { sensitive: true, strict: false })
    for (const hook of templatesGeneratedHooks) await hook({ ...app, components: [] })
    expect(setRoutes).toHaveBeenLastCalledWith([{
      path: "/", files: ["/app/pages/index.vue"],
    }], { sensitive: true, strict: false })
  })

  it("finalizes Sandbox Wrangler config after every Nuxt replay contributor", async () => {
    const configResolved = vi.fn((config: { nitro?: Record<string, unknown> }) => {
      const migrations = ((config.nitro!.cloudflare as Record<string, unknown>).wrangler as Record<string, unknown>).migrations as Array<Record<string, unknown>>
      migrations.splice(0, migrations.length, {
        tag: "shared-v1",
        new_sqlite_classes: migrations.flatMap(migration => migration.new_sqlite_classes as string[] || []),
      })
    })
    mocks.vitehub.mockReturnValue([
      {
        name: "@vite-hub/sandbox/task/vite",
        config: mocks.sandboxTaskHook,
        configResolved,
      },
      {
        name: "vite-hub/later-cloudflare",
        config(config: { nitro?: Record<string, unknown> }) {
          const cloudflare = config.nitro?.cloudflare as Record<string, unknown>
          const wrangler = cloudflare.wrangler as Record<string, unknown>
          ;(wrangler.migrations as Array<Record<string, unknown>>).push({
            tag: "shared-v1",
            new_sqlite_classes: ["LaterObject"],
          })
        },
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig = {
      cloudflare: {
        wrangler: {
          migrations: [{ tag: "shared-v1", new_sqlite_classes: ["Sandbox"] }],
        },
      },
    }

    await viteHubNuxtModule({ host: "cloudflare", sandboxTask: true }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(configResolved).toHaveBeenCalledOnce()
    expect(nitroConfig.cloudflare.wrangler.migrations).toEqual([{
      tag: "shared-v1",
      new_sqlite_classes: ["Sandbox", "LaterObject"],
    }])
  })

  it("replays Env configuration with the selected CLI stage", async () => {
    const development = createNuxt(true)
    development.nuxt.options.vite = { mode: "staging" }
    await viteHubNuxtModule({ host: "node" }, development.nuxt)
    await development.runNitroConfigHook({})
    expect(mocks.envHook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ command: "serve", mode: "staging" }))
  })

  it("enables Agent invocation in Nuxt development and keeps production read-only by default", async () => {
    const development = createNuxt(true)
    const existingConsoleHandler = vi.fn()
    development.nuxt.options.devServerHandlers = [{ handler: existingConsoleHandler, route: "/_vitehub/api" }]
    development.nuxt.options.routeRules["/_vitehub/**"] = {
      headers: { "cache-control": "private" },
      swr: false,
    }
    await viteHubNuxtModule({ agent: true, blob: true, comments: false, console: { auth: false }, kv: true, host: "node" }, development.nuxt)

    // Apps serve no Console page, client script, or page assets. The hosted Console reads the endpoints, and
    // `/_vitehub` only sends the browser there.
    expect(nitroOptions(development.nuxt).handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub", handler: expect.stringMatching(/server\/site-entry\.js$/) }))
    expect(nitroHandlerRoutes(nitroOptions(development.nuxt))).not.toEqual(expect.arrayContaining(["/_vitehub/**"]))
    expect(nitroOptions(development.nuxt).publicAssets).toEqual([{
      baseURL: "/_vitehub/.well-known/skills",
      dir: expect.stringMatching(/console\/runtime\/public\/skills$/),
      fallthrough: false,
    }, {
      // The Console link of the page tools pill, and the page tools loader for an app without Comments.
      baseURL: "/_vitehub/console/assets",
      dir: expect.stringMatching(/console\/runtime\/page-tool$/),
      maxAge: 300,
    }, {
      baseURL: "/_vitehub/page/assets",
      dir: expect.stringMatching(/console\/runtime\/page$/),
      maxAge: 300,
    }])
    expect(development.nuxt.options.nitro).toMatchObject({
      handlers: [{ route: "/_vitehub/rpc" }, { route: "/_vitehub" }, { route: "/_vitehub/page/session" }],
      plugins: [`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`],
    })
    // The app's own route rules stay as they were. ViteHub adds no Console page rules.
    expect(development.nuxt.options.routeRules).toEqual({ "/_vitehub/**": { headers: { "cache-control": "private" }, swr: false } })
    expect(development.nuxt.options.devServerHandlers).toEqual([{ handler: existingConsoleHandler, route: "/_vitehub/api" }])
    expect(development.nuxt.options.vite.plugins).toContainEqual(expect.objectContaining({ name: "vite-hub/console-invocation-root" }))
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(
      `installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","agents","skills","usage","channels","blob","kv","workflows"])`,
    )
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(
      `installConsoleAgentDefinitions([], { projectRoot: "${tmp}/vitehub-nuxt", invoke: true, capabilities: async () => {`,
    )
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(
      `installConsoleBlob("${tmp}/vitehub-nuxt", vitehubConsoleBlob, ["default"])`,
    )
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toMatch(
      kvConsoleSections,
    )

    const production = createNuxt(false)
    await viteHubNuxtModule(
      {
        agent: true,
        comments: false, console: productionConsole,
        kv: true,
        host: "node",
      },
      production.nuxt,
    )
    expect(production.nuxt.options.nitro).toMatchObject({
      handlers: [{ route: "/_vitehub/rpc" }, { route: "/_vitehub" }, { route: "/_vitehub/page/session" }],
      plugins: expect.arrayContaining([`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`]),
    })
    expect(Object.keys(production.nuxt.options.routeRules ?? {})).not.toContain("/_vitehub/**")
    expect(production.nuxt.options.devServerHandlers).toBeUndefined()
    expect(production.nuxt.options.vite.plugins).toContainEqual(expect.objectContaining({ name: "vite-hub/console-invocation-root" }))
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(
      `installConsoleAgentDefinitions([], { projectRoot: "${tmp}/vitehub-nuxt", capabilities: async () => {`,
    )
  })

  it.each([true, false])("builds Connections without a Console section (dev: %s)", async (dev) => {
    const application = createNuxt(dev)
    try {
      const configure = () => viteHubNuxtModule({
        host: "node",
        connections: true,
        database: true,
        console: dev ? { auth: false } : productionConsole,
      }, application.nuxt)
      await configure()
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated.includes('"connections"')).toBe(false)
    }
    finally {
      await application.runCloseHook()
    }
  })

  it("gives Nuxt Connections the implicit default Database when the app has no Database Definition", async () => {
    const { viteHubPlugins: vitehub } = await vi.importActual<typeof import("../src/plugins.ts")>("../src/plugins.ts")
    mocks.vitehub.mockImplementation((options: Parameters<typeof vitehub>[0]) => vitehub(options).filter(
      plugin => isTestRecord(plugin) && plugin.name === "@vite-hub/connections/vite",
    ))
    const application = createNuxt(true)
    const definition = `${tmp}/vitehub-nuxt/custom-server/databases/default.ts`
    await rm(definition, { force: true })
    await rm(`${tmp}/vitehub-nuxt/.vitehub/connections/database.ts`, { force: true })
    try {
      await viteHubNuxtModule({ host: "node", connections: true, console: { auth: false } }, application.nuxt)
      const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
      const { discoverDatabaseDefinitions, isImplicitDefaultDatabase } = await import("@vite-hub/database/config")
      const serverDirs = [`${tmp}/vitehub-nuxt/custom-server`]
      const contributions = await collectDatabaseContributions(application.nuxt.options.vite.plugins, {
        projectRoot: `${tmp}/vitehub-nuxt`,
        root: `${tmp}/vitehub-nuxt/app`,
        rootDir: `${tmp}/vitehub-nuxt`,
        serverDirs,
      })
      // Connections ask for the default Database. They do not add a Definition of their own.
      expect(contributions.definitions).toEqual([])
      expect(contributions.uses).toEqual([expect.objectContaining({ database: "default", dialect: "sqlite", name: "connections", plugin: "@vite-hub/connections/vite" })])
      const discover = () => discoverDatabaseDefinitions(`${tmp}/vitehub-nuxt`, { contributions, implicitDefault: true, serverDirs })
      expect(discover().map(isImplicitDefaultDatabase)).toEqual([true])
      await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/connections/database.ts`, "utf8")).rejects.toThrow()

      await mkdir(dirname(definition), { recursive: true })
      await writeFile(definition, "export default defineDatabase({ schema: {} })\n")
      expect(discover()).toEqual([expect.objectContaining({ handler: definition, name: "default" })])
    }
    finally {
      await rm(definition, { force: true })
      await application.runCloseHook()
    }
  })

  it.each([
    ["/", false],
    ["/portal/", false],
    ["/", true],
    ["/portal/", true],
  ] as const)("publishes the Nuxt dev server with base %s (Console: %s), and removes the file on close", async (baseURL, consoleEnabled) => {
    const file = `${tmp}/vitehub-nuxt/.vitehub/dev-server.json`
    await rm(file, { force: true })
    const application = createNuxt(true)
    Object.assign(application.nuxt.options, { app: { baseURL } })
    await viteHubNuxtModule({ host: "node", console: consoleEnabled ? { auth: false } : false }, application.nuxt)
    expect(application.listenHooks).toHaveLength(consoleEnabled ? 2 : 1)
    // Nothing is written before Nuxt listens.
    await expect(readFile(file, "utf8")).rejects.toThrow()
    const server = new EventEmitter()
    const upgrade = vi.fn()
    server.on("upgrade", upgrade)
    for (const listen of application.listenHooks) listen(server, { url: "http://localhost:3000/" })
    expect(server.listeners("upgrade")).toEqual(consoleEnabled ? [viteHubDevPeerUpgradeListener, upgrade] : [upgrade])
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ root: `${tmp}/vitehub-nuxt`, url: `http://localhost:3000${baseURL}` })
    await application.runCloseHook()
    await expect(readFile(file, "utf8")).rejects.toThrow()
  })

  it("prints the open-access notice of a Nuxt dev server without a link to the hosted Console", async () => {
    const application = createNuxt(true)
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      await viteHubNuxtModule({ host: "node", console: { auth: false } }, application.nuxt)
      const server = Object.assign(new EventEmitter(), { address: () => ({ address: "::1", port: 3000 }) })
      for (const listen of application.listenHooks) listen(server, { url: "http://localhost:3000/" })
      expect(info).toHaveBeenCalledWith(expect.stringContaining("without a signature"))
      expect(info).not.toHaveBeenCalledWith(expect.stringContaining("console.vitehub.dev/open"))
    }
    finally {
      info.mockRestore()
      await application.runCloseHook()
    }
  })

  it("does not publish a dev server for a build or for CLI discovery", async () => {
    const build = createNuxt(false)
    await viteHubNuxtModule({ host: "node" }, build.nuxt)
    expect(build.listenHooks).toHaveLength(0)
    const discovery = createNuxt(true)
    discovery.nuxt.options.vitehubCliDiscovery = true
    await viteHubNuxtModule({ host: "node" }, discovery.nuxt)
    expect(discovery.listenHooks).toHaveLength(0)
  })

  it("leaves the dev server's Console plugin alone during CLI discovery", async () => {
    const plugin = `${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`
    await rm(plugin, { force: true })
    const discovery = createNuxt(true)
    discovery.nuxt.options.vitehubCliDiscovery = true
    await viteHubNuxtModule({ host: "node", agent: true, console: productionConsole }, discovery.nuxt)
    await discovery.runNitroConfigHook({})

    // CLI discovery resolves no Console access, so a plugin that it wrote would differ and rebuild the dev server.
    await expect(readFile(plugin, "utf8")).rejects.toThrow()
    await discovery.runCloseHook()
  })

  it("tells replayed Vite plugins about CLI discovery, so the Console RPC plugin leaves the dev server's plugin alone", async () => {
    const plugin = `${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`
    await rm(plugin, { force: true })
    // A Nuxt app without a `console` option still gets the Console RPC plugin for `vitehub <command>`.
    mocks.vitehub.mockReturnValue([consoleVitePlugin({ rpcOnly: true })])
    const discovery = createNuxt(true)
    discovery.nuxt.options.vitehubCliDiscovery = true
    await viteHubNuxtModule({ host: "node" }, discovery.nuxt)
    await discovery.runNitroConfigHook({})

    // The running dev server watches this file. A CLI rewrite reloads its Nitro worker, which can read the file empty.
    await expect(readFile(plugin, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await discovery.runCloseHook()
  })

  it.each([undefined, false] as const)("passes console: %o to vitehub(), which decides on the development operation RPC", async (value) => {
    const application = createNuxt(true)
    await viteHubNuxtModule({ console: value, env: false, host: "node" }, application.nuxt)

    const options: unknown = mocks.vitehub.mock.lastCall?.[0]
    expect(options).toHaveProperty("console", value)
    await application.runCloseHook()
  })

  it.each([false, true])("carries the Node data directory into the Nuxt Agent journal with the Console on: %s", async (consoleOn) => {
    await rm(agentJournalPlugin, { force: true })
    const application = createNuxt(false)
    await viteHubNuxtModule({
      host: "node",
      dataDir: `${tmp}/vitehub-nuxt/persistent data`,
      agent: true,
      ...(consoleOn ? { console: productionConsole } : {}),
    }, application.nuxt)

    await expect(generatedAgentJournal(application)).resolves.toContain(
      `"databaseUrl":${JSON.stringify(pathToFileURL(`${tmp}/vitehub-nuxt/persistent data/agent-invocations.sqlite`).href)}`,
    )
    if (consoleOn) await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.not.toContain("databaseUrl")
    await application.runCloseHook()
  })

  it.each([false, true])("stores the Cloudflare Agent journal in a discovered D1 Database binding with the Console on: %s", async (consoleOn) => {
    await rm(agentJournalPlugin, { force: true })
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n')
    const application = createNuxt(false)
    await viteHubNuxtModule({
      host: "cloudflare",
      agent: true,
      ...(consoleOn ? { console: productionConsole } : {}),
      database: true,
    }, application.nuxt)

    await expect(generatedAgentJournal(application)).resolves.toContain(`d1: { binding: "APP_DB", env: async () => (await import("cloudflare:workers")).env }`)
    await application.runCloseHook()
  })

  it.each(["", 'cloudflare: { binding: "APP_DB", databaseName: "app" },'])("uses the effective Nuxt D1 Database binding with Definition config %s", async (config) => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, `export default defineDatabase({ ${config} schema: {} })\n`)
    const application = createNuxt(false)
    await viteHubNuxtModule({
      host: "cloudflare",
      agent: true,
      console: productionConsole,
      database: { driver: "d1" },
    }, application.nuxt)
    const generated = await generatedAgentJournal(application)
    expect(generated).toContain(`d1: { binding: "${config ? "APP_DB" : "DB"}",`)
    await application.runCloseHook()
  })

  it.each(["", 'dialect: "postgresql",'])("does not invent a separate Nuxt Content resource for discovered Definitions: %s", async (dialect) => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, `export default defineDatabase({ ${dialect} schema: {} })\n`)
    const application = createNuxt(true)
    await viteHubNuxtModule({ host: "cloudflare", database: true }, application.nuxt)

    expect((application.nuxt.options as { content?: { database?: unknown } }).content?.database).toBeUndefined()
    await application.runCloseHook()
  })

  it.each([false, true])("checks the Cloudflare Agent journal file URL only in a build (prepare: %s)", async (prepare) => {
    await rm(agentJournalPlugin, { force: true })
    const invocations = { databaseUrl: "file:./journal.sqlite" }
    mocks.vitehub.mockReturnValue([agentInvocationsVitePlugin({ database: false, default: invocations, host: "cloudflare" })])
    const application = createNuxt(false)
    Object.assign(application.nuxt.options, { _prepare: prepare })
    const result = viteHubNuxtModule({ agent: { invocations }, console: false, env: false, host: "cloudflare" }, application.nuxt)

    if (prepare) {
      await expect(result).resolves.toBeUndefined()
      const generated = await generatedAgentJournal(application)
      expect(generated).toContain('"databaseUrl":"file:./journal.sqlite"')
      await expect(generatedAgentJournal(application, true)).resolves.toBe(generated)
    }
    else {
      await expect(result).rejects.toThrow("agent.invocations.databaseUrl is a local file")
    }
    await application.runCloseHook()
  })

  it("rejects maxSize with a remote default journal before Nuxt code generation", async () => {
    const application = createNuxt(false)
    await expect(viteHubNuxtModule({
      host: "node",
      agent: { invocations: { databaseUrl: "libsql://journal.example.com", retention: { maxSize: "500 MB" } } },
    }, application.nuxt)).rejects.toThrow("agent.invocations.retention.maxSize needs a local SQLite file")
    await application.runCloseHook()
  })

  it("reads Database options only from the vite-hub/nuxt options, not from a top-level Nuxt `database` key", async () => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, 'export default defineDatabase({ schema: {} })\n')
    const application = createNuxt(false)
    Object.assign(application.nuxt.options, {
      database: { binding: "TOP_LEVEL_DB", driver: "d1" },
    })
    await viteHubNuxtModule({
      host: "cloudflare",
      agent: true,
      console: productionConsole,
      database: true,
    }, application.nuxt)
    const generated = await generatedAgentJournal(application)
    expect(generated).not.toContain("TOP_LEVEL_DB")
    // The Database integration must not read the top-level key either, or the Database and the journal disagree.
    const databaseOptions = getResolvedFeatureOptions<{ binding?: string }>(application.nuxt.options.vite, "database")
    expect(databaseOptions).toMatchObject({ driver: "d1" })
    expect(databaseOptions?.binding).toBeUndefined()
    await application.runCloseHook()
  })

  it("keeps the effective Nuxt D1 binding when the Vite build runs the Agent journal plugin again", async () => {
    const { viteHubPlugins: vitehub } = await vi.importActual<typeof import("../src/plugins.ts")>("../src/plugins.ts")
    mocks.vitehub.mockImplementation((options: Parameters<typeof vitehub>[0]) => vitehub(options).filter(
      plugin => isTestRecord(plugin) && plugin.name === "vite-hub/agent-invocations",
    ))
    await rm(agentJournalPlugin, { force: true })
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    // The Definition's D1 binding differs from the `database: true` that vitehub() receives.
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n')
    const application = createNuxt(false)
    await viteHubNuxtModule({ host: "cloudflare", agent: true, database: true }, application.nuxt)
    expect(await generatedAgentJournal(application)).toContain('d1: { binding: "APP_DB",')

    // `nuxt build` runs the Vite config hooks of the module's plugins after the module wrote the plugin.
    const plugin = (application.nuxt.options.vite.plugins as unknown[]).find(
      (candidate): candidate is Plugin => isTestRecord(candidate) && candidate.name === "vite-hub/agent-invocations",
    )
    const hook = plugin?.config
    if (!hook) throw new TypeError("Expected the Agent Invocations config hook.")
    await Reflect.apply("handler" in hook ? hook.handler : hook, {}, [application.nuxt.options.vite, { command: "build", mode: "production" }])
    expect(await readFile(agentJournalPlugin, "utf8")).toContain('d1: { binding: "APP_DB",')
    await application.runCloseHook()
  })

  it.each([false, { binding: "REPLAY_DB", databaseId: "replay-id", databaseName: "replayed", driver: "d1" as const }])("uses replayed Database configuration for the Cloudflare journal: %j", async (database) => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, 'export default defineDatabase({ schema: {} })\n')
    const application = createNuxt(false, [{
      name: "vite-hub/database-replay",
      config: () => resolvedFeatures({ database }),
    }])
    await viteHubNuxtModule({
      host: "cloudflare", agent: true, console: productionConsole,
      database: { binding: "INITIAL_DB", databaseId: "initial-id", databaseName: "initial", driver: "d1" },
    }, application.nuxt)
    const generated = await generatedAgentJournal(application, true)
    expect(generated).not.toContain('d1: { binding: "INITIAL_DB",')
    if (database) expect(generated).toContain('d1: { binding: "REPLAY_DB",')
    else expect(generated).not.toContain("d1: { binding:")
    await application.runCloseHook()
  })

  it.each([undefined, "replayed"])("uses the replayed Database discovery root for the Cloudflare journal: %s", async (projectRoot) => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/initial/server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/initial/server/databases/default.ts`, 'export default defineDatabase({ cloudflare: { binding: "INITIAL_DB", databaseId: "initial-id", databaseName: "initial" }, schema: {} })\n')
    const definitionRoot = projectRoot ? `${tmp}/vitehub-nuxt/replayed/server` : `${tmp}/vitehub-nuxt/custom-server`
    await mkdir(resolve(definitionRoot, "databases"), { recursive: true })
    await writeFile(resolve(definitionRoot, "databases/default.ts"), 'export default defineDatabase({ cloudflare: { binding: "REPLAY_DB", databaseId: "replayed-id", databaseName: "replayed" }, schema: {} })\n')
    const application = createNuxt(false, [{
      name: "vite-hub/database-replay",
      config(config: UserConfig) {
        setResolvedFeatureOptions(config, "database", { projectRoot })
      },
    }])
    await viteHubNuxtModule({
      host: "cloudflare", agent: true, console: productionConsole,
      database: { databaseId: "initial-id", databaseName: "initial", projectRoot: "custom-server/initial" },
    }, application.nuxt)
    const generated = await generatedAgentJournal(application, true)
    expect(generated).toContain('d1: { binding: "REPLAY_DB",')
    expect(generated).not.toContain('d1: { binding: "INITIAL_DB",')
    await application.runCloseHook()
  })

  it("discovers the Nuxt Console D1 journal from the Database project root", async () => {
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/databases/default.ts`, 'export default defineDatabase({ cloudflare: { binding: "APP_DB", databaseName: "app" }, schema: {} })\n')
    await mkdir(`${tmp}/vitehub-nuxt/custom-server/data/server/databases`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/custom-server/data/server/databases/default.ts`, 'export default defineDatabase({ cloudflare: { binding: "DATA_DB", databaseName: "data" }, schema: {} })\n')
    const application = createNuxt(false)
    await viteHubNuxtModule({
      host: "cloudflare",
      agent: true,
      console: productionConsole,
      database: { projectRoot: "custom-server/data" },
    }, application.nuxt)
    const generated = await generatedAgentJournal(application)
    expect(generated).toContain('d1: { binding: "DATA_DB",')
    expect(generated).not.toContain('d1: { binding: "APP_DB",')
    await application.runCloseHook()
  })

  it.each([undefined, "data"])("discovers the Nuxt Console D1 journal above an app root with Database projectRoot %s", async (databaseProjectRoot) => {
    const directory = await mkdtemp("/tmp/vitehub-nuxt-journal-root-")
    try {
      const appRoot = resolve(directory, "app")
      const databaseRoot = databaseProjectRoot ? resolve(appRoot, databaseProjectRoot) : directory
      await mkdir(appRoot, { recursive: true })
      await writeFile(resolve(directory, "package.json"), '{"name":"journal-root"}\n')
      await mkdir(resolve(databaseRoot, "src"), { recursive: true })
      await writeFile(resolve(databaseRoot, "src/database.ts"), 'export default defineDatabase({ cloudflare: { binding: "PROJECT_DB", databaseName: "project" }, schema: {} })\n')
      const application = createNuxt(false)
      application.nuxt.options.rootDir = appRoot
      application.nuxt.options.serverDir = resolve(appRoot, "server")
      await viteHubNuxtModule({
        host: "cloudflare",
        agent: true,
        console: productionConsole,
        database: databaseProjectRoot ? { projectRoot: databaseProjectRoot } : true,
      }, application.nuxt)
      const generated = await readFile(resolve(directory, ".vitehub/nitro/agent/invocations.mjs"), "utf8")
      expect(generated).toContain('d1: { binding: "PROJECT_DB",')
      await application.runCloseHook()
    }
    finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it("keeps libSQL for the Nuxt Agent journal with a libSQL Database on Cloudflare", async () => {
    const application = createNuxt(false)
    await viteHubNuxtModule({
      host: "cloudflare",
      agent: true,
      console: productionConsole,
      database: { connection: { url: "libsql://journal.example.com" } },
    }, application.nuxt)

    const generated = await generatedAgentJournal(application)
    expect(generated).toContain("journal: { projectRoot: ")
    expect(generated).not.toContain("cloudflare:workers")
    await application.runCloseHook()
  })

  it("preserves Console shorthand invocation with a Node data directory", async () => {
    const application = createNuxt(true)
    await viteHubNuxtModule({
      host: "node",
      dataDir: `${tmp}/vitehub-nuxt/persistent data`,
      agent: true,
      console: { auth: false },
    }, application.nuxt)
    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).toContain("invoke: true")
    expect(generated).not.toContain("databaseUrl")
    await application.runCloseHook()
  })

  it("installs only KV navigation and metadata for a KV-only Console", async () => {
    const development = createNuxt(true)

    await viteHubNuxtModule({
      comments: false, console: productionConsole,
      kv: {
        stores: {
          cache: { base: ".vitehub/data/cache", driver: "fs-lite" },
          default: { driver: "fs-lite" },
        },
      },
      host: "node",
    }, development.nuxt)
    expect(development.nuxt.options.nitro).toMatchObject({
      handlers: [{ route: "/_vitehub/rpc" }, { route: "/_vitehub" }, { route: "/_vitehub/page/session" }],
    })
    expect(development.nuxt.options.vite.plugins).not.toContainEqual(expect.objectContaining({ name: "vite-hub/console-invocation-root" }))
    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
    expect(generated).not.toContain(`from "vite-hub/console/server"`)
    expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","kv"])`)
    expect(generated).not.toContain("installConsoleInvocations")
  })

  it("adds no Console tab to Nuxt DevTools", async () => {
    const development = createNuxt(true)
    Object.assign(development.nuxt.options, { app: { baseURL: "/portal/" } })
    await viteHubNuxtModule({ console: { auth: false }, host: "node" }, development.nuxt)

    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(`installConsoleDevelopment("${tmp}/vitehub-nuxt", true, "/__vitehub/setup")`)
    expect(development.runDevToolsCustomTabsHook()).toEqual([])

    const production = createNuxt(false)
    await viteHubNuxtModule({ console: productionConsole, host: "node" }, production.nuxt)

    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(`installConsoleDevelopment("${tmp}/vitehub-nuxt", false)`)
    expect(production.runDevToolsCustomTabsHook()).toEqual([])
  })

  // Nitro adds its `baseURL`, which Nuxt sets to `app.baseURL`, to every route, asset, and route rule. A route that
  // already has the base answers at `/portal/portal/_vitehub`. The Vercel preset turned `//_vitehub/...` into `/_vitehub`.
  it.each([["/", ""], ["/portal/", "/portal"]])("mounts every Console route once below Nuxt app.baseURL %s", async (baseURL, mount) => {
    const production = createNuxt(false)
    Object.assign(production.nuxt.options, { app: { baseURL } })
    await viteHubNuxtModule({ console: productionConsole, host: "vercel" }, production.nuxt)

    // SAFETY: The Console adds Nitro handler and public asset records; the assertions read their paths.
    const { handlers, publicAssets } = nitroOptions(production.nuxt) as { handlers: Array<{ route: string }>, publicAssets: Array<{ baseURL?: string }> }
    const paths = [...handlers.map(handler => handler.route), ...publicAssets.map(asset => asset.baseURL)]
    expect(paths.filter(path => path?.includes("//"))).toEqual([])
    if (mount) expect(paths.filter(path => path?.startsWith(mount))).toEqual([])
    expect(handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/rpc" }))
    expect(handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/page/session" }))
    expect(publicAssets).toContainEqual(expect.objectContaining({ baseURL: "/_vitehub/.well-known/skills" }))
  })

  it.each([false, true])("keeps one Console route below the Nuxt base after config replay (dev: %s)", async (dev) => {
    const application = createNuxt(dev)
    Object.assign(application.nuxt.options, { app: { baseURL: "/portal/" } })
    await viteHubNuxtModule({ console: true, host: "node" }, application.nuxt)

    const config = nitroOptions(application.nuxt)
    const assertRoutes = () => {
      expect((config.plugins as string[] | undefined ?? []).filter(plugin => /console-preflight|mcp-discovery/.test(plugin))).toEqual([])
      expect(nitroHandlerRoutes(config)).toContain("/_vitehub/rpc")
      expect(nitroHandlerRoutes(config)).not.toContain("/_vitehub/mcp")
      expect(nitroHandlerRoutes(config)).toContain("/_vitehub")
      expect(nitroHandlerRoutes(config).filter(route => route?.startsWith("/portal"))).toEqual([])
    }
    try {
      assertRoutes()
      await application.runNitroConfigHook(config)
      assertRoutes()
      await application.runNitroConfigHook(config)
      assertRoutes()
    }
    finally {
      await application.runCloseHook()
    }
  })

  it("keeps resolved Nuxt features when applying the effective KV configuration", async () => {
    const { viteHubPlugins: vitehub } = await vi.importActual<typeof import("../src/plugins.ts")>("../src/plugins.ts")
    mocks.vitehub.mockImplementation((options: Parameters<typeof vitehub>[0]) => vitehub(options).filter(
      plugin => isTestRecord(plugin) && plugin.name === "vite-hub/agent-invocations",
    ))
    const application = createNuxt(false)
    // With journals off, ViteHub adds the plugin only for a Database, which the effective configuration must not turn on.
    await viteHubNuxtModule({ agent: { invocations: false }, host: "node" }, application.nuxt)
    expect(application.nuxt.options.vite.plugins).not.toContainEqual(expect.objectContaining({ name: "vite-hub/agent-invocations" }))
  })

  it.each([false, true])("uses the KV configuration for Nitro cache and the `kv` mount (dev: %s)", async (dev) => {
    const { viteHubPlugins: vitehub } = await vi.importActual<typeof import("../src/plugins.ts")>("../src/plugins.ts")
    mocks.vitehub.mockImplementation((options: Parameters<typeof vitehub>[0]) => vitehub(options).filter(
      plugin => isTestRecord(plugin) && ["vite-hub/deployment-host", "@vite-hub/kv/vite"].includes(String(plugin.name)),
    ))

    const enabled = createNuxt(dev)
    await viteHubNuxtModule({ cache: { driver: "kv" }, kv: { driver: "fs-lite" }, host: "node" }, enabled.nuxt)
    expect(enabled.nuxt.options.vite.plugins).toContainEqual(expect.objectContaining({ name: "@vite-hub/kv/vite" }))
    const config = { ...nitroOptions(enabled.nuxt), imports: { imports: [] } }
    await enabled.runNitroConfigHook(config)
    expect(config.imports).toMatchObject({ imports: expect.arrayContaining([{ from: "vite-hub/kv", name: "kv", priority: -1 }]) })
    const mount = { base: "nitro-cache", driver: kvCacheDriver }
    expect(config).toMatchObject({ $development: { kv: { cache: mount } }, kv: { cache: mount, kv: { driver: kvCacheDriver } } })

    const disabled = createNuxt(dev)
    await viteHubNuxtModule({ cache: { driver: "kv" }, kv: false, host: "node" }, disabled.nuxt)
    await expect(disabled.runNitroConfigHook(nitroOptions(disabled.nuxt))).rejects.toThrow("`kv` is not enabled")
  })

  it("uses the KV configuration for the Nuxt Console", async () => {
    const named = createNuxt(true)
    const stores = {
      default: { driver: "fs-lite" as const },
      cache: { driver: "fs-lite" as const },
      sessions: { driver: "fs-lite" as const },
    }

    await viteHubNuxtModule({ console: { auth: false }, kv: { stores }, host: "node" }, named.nuxt)

    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toMatch(
      kvConsoleSections,
    )

    mocks.vitehub.mockReturnValue([])

    const disabled = createNuxt(true)
    await viteHubNuxtModule({ console: { auth: false }, kv: false, host: "node" }, disabled.nuxt)
    const disabledNitroConfig = nitroOptions(disabled.nuxt)
    await disabled.runNitroConfigHook(disabledNitroConfig)

    await expect(generatedConsoleSections()).resolves.not.toContain("kv")
    expect(disabledNitroConfig.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/rpc" }))

    const applicationKVHandler = { handler: "/tmp/application-kv-handler.ts", route: "/_vitehub/api/kv" }
    const conflicting = createNuxt(true)
    conflicting.nuxt.options.nitro = { handlers: [applicationKVHandler] }

    await viteHubNuxtModule({ console: { auth: false }, kv: { driver: "fs-lite" }, host: "node" }, conflicting.nuxt)
    expect(nitroOptions(conflicting.nuxt).handlers).toEqual(expect.arrayContaining([
      applicationKVHandler,
      expect.objectContaining({ route: "/_vitehub/rpc" }),
    ]))
  })

  it("keeps an application Blob route beside the Console RPC route", async () => {
    const development = createNuxt(true)
    development.nuxt.options.nitro = {
      handlers: [{ handler: "~/server/api/blob.ts", route: "/_vitehub/api/blob" }],
    }

    await viteHubNuxtModule({ blob: true, console: { auth: false }, host: "node" }, development.nuxt)
    expect(nitroOptions(development.nuxt).handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "/_vitehub/api/blob" }),
      expect.objectContaining({ route: "/_vitehub/rpc" }),
    ]))
  })

  it("uses the effective Vite Blob stores for the Nuxt Console", async () => {
    const development = createNuxt(true)
    const blob = {
      stores: {
        archive: { base: ".vitehub/data/archive", driver: "fs" as const },
        default: { base: ".vitehub/data/default", driver: "fs" as const },
        media: { base: ".vitehub/data/media", driver: "fs" as const },
      },
    }

    await viteHubNuxtModule({ blob, console: { auth: false }, host: "node" }, development.nuxt)

    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain(
      `installConsoleBlob("${tmp}/vitehub-nuxt", vitehubConsoleBlob, ["default","archive","media"])`,
    )
  })

  it("uses replay-resolved Database configuration for the Nuxt Console", async () => {
    const development = createNuxt(true, [{
      name: "vite-hub/database-replay",
      config: () => resolvedFeatures({ database: false }),
    }])

    await viteHubNuxtModule({ comments: false, console: productionConsole, database: true, host: "node" }, development.nuxt)
    const nitroConfig = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(nitroConfig)
    expect(nitroHandlerRoutes(nitroConfig)).not.toContain("/_vitehub/api/definitions")
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.not.toContain(
      "installConsoleDefinitions",
    )
  })

  it("discovers the Nuxt Console Database catalog from the configured project root", async () => {
    const definition = `${tmp}/vitehub-nuxt/data/server/databases/default.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: { notes } })\n")
    const development = createNuxt(true)
    development.nuxt.options.serverDir = undefined

    try {
      await viteHubNuxtModule({ console: { auth: false }, database: { projectRoot: "data" }, host: "node" }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"data/server/databases/default.ts"`)
      expect(generated).toContain(`"name":"default"`)
    }
    finally {
      await rm(`${tmp}/vitehub-nuxt/data`, { force: true, recursive: true })
    }
  })

  it("resolves the Database project root before Nuxt runtime and Console setup", async () => {
    const definition = `${tmp}/vitehub-nuxt/app/packages/db/server/databases/default.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: { notes } })\n")
    const development = createNuxt(true)
    Object.assign(development.nuxt.options.vite, { root: "app" })
    development.nuxt.options.serverDir = undefined

    try {
      await viteHubNuxtModule({ console: { auth: false }, database: { projectRoot: "app/packages/db" }, host: "node" }, development.nuxt)
      expect(getResolvedFeatureOptions(development.nuxt.options.vite, "database")).toMatchObject({
        projectRoot: `${tmp}/vitehub-nuxt/app/packages/db`,
      })
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"app/packages/db/server/databases/default.ts"`)
      expect(generated).toContain(`"name":"default"`)
    }
    finally {
      await rm(`${tmp}/vitehub-nuxt/app/packages/db`, { force: true, recursive: true })
    }
  })

  it("uses the replay-resolved default Database root for the Nuxt Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/server/databases/default.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(definition, "export default defineDatabase({ schema: { notes } })\n")
    const development = createNuxt(true, [{
      name: "vite-hub/database-replay",
      config: () => resolvedFeatures({
        database: { projectRoot: `${tmp}/vitehub-nuxt` },
      }),
    }])
    development.nuxt.options.rootDir = `${tmp}/vitehub-nuxt/app`
    development.nuxt.options.serverDir = undefined

    try {
      await viteHubNuxtModule({ console: { auth: false }, database: true, host: "node" }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"server/databases/default.ts"`)
      expect(generated).toContain(`"name":"default"`)
    }
    finally {
      await rm(resolve(definition, "../.."), { force: true, recursive: true })
    }
  })

  it("prefers an explicit replayed Database root over the configured root", async () => {
    const runtimeDefinition = `${tmp}/vitehub-nuxt/server/databases/default.ts`
    const nuxtDefinition = `${tmp}/vitehub-nuxt/custom-server/databases/default.ts`
    await mkdir(resolve(runtimeDefinition, ".."), { recursive: true })
    await mkdir(resolve(nuxtDefinition, ".."), { recursive: true })
    await writeFile(runtimeDefinition, "export default defineDatabase({ schema: { runtime } })\n")
    await writeFile(nuxtDefinition, "export default defineDatabase({ schema: { nuxt } })\n")
    const development = createNuxt(true, [{
      name: "vite-hub/database-replay",
      config: () => resolvedFeatures({
        database: { projectRoot: "." },
      }),
    }])

    try {
      await viteHubNuxtModule({
        console: { auth: false },
        database: { projectRoot: `${tmp}/vitehub-nuxt/custom-server` },
        host: "node",
      }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"server/databases/default.ts"`)
      expect(generated).toContain(`"value":"runtime"`)
      expect(generated).not.toContain(`"file":"custom-server/databases/default.ts"`)
      expect(generated).not.toContain(`"value":"nuxt"`)
    }
    finally {
      await rm(resolve(runtimeDefinition, "../.."), { force: true, recursive: true })
      await rm(resolve(nuxtDefinition, "../.."), { force: true, recursive: true })
    }
  })

  it("preserves a replay-cleared Database root for the Nuxt Console", async () => {
    const runtimeDefinition = `${tmp}/vitehub-nuxt/custom-server/databases/default.ts`
    const configuredDefinition = `${tmp}/vitehub-nuxt/configured-database/server/databases/default.ts`
    await mkdir(resolve(runtimeDefinition, ".."), { recursive: true })
    await mkdir(resolve(configuredDefinition, ".."), { recursive: true })
    await writeFile(runtimeDefinition, "export default defineDatabase({ schema: { runtime } })\n")
    await writeFile(configuredDefinition, "export default defineDatabase({ schema: { configured } })\n")
    const development = createNuxt(true, [{
      name: "vite-hub/database-replay",
      config: () => resolvedFeatures({ database: {} }),
    }])

    try {
      await viteHubNuxtModule({
        console: { auth: false },
        database: { projectRoot: `${tmp}/vitehub-nuxt/configured-database` },
        host: "node",
      }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"custom-server/databases/default.ts"`)
      expect(generated).toContain(`"value":"runtime"`)
      expect(generated).not.toContain(`"file":"configured-database/server/databases/default.ts"`)
      expect(generated).not.toContain(`"value":"configured"`)
    }
    finally {
      await rm(resolve(runtimeDefinition, "../.."), { force: true, recursive: true })
      await rm(resolve(configuredDefinition, "../.."), { force: true, recursive: true })
    }
  })

  it("preserves an in-place replayed Database root with a custom Nuxt server directory", async () => {
    const runtimeDefinition = `${tmp}/vitehub-nuxt/server/databases/default.ts`
    const nuxtDefinition = `${tmp}/vitehub-nuxt/custom-server/databases/default.ts`
    await mkdir(resolve(runtimeDefinition, ".."), { recursive: true })
    await mkdir(resolve(nuxtDefinition, ".."), { recursive: true })
    await writeFile(runtimeDefinition, "export default defineDatabase({ schema: { runtime } })\n")
    await writeFile(nuxtDefinition, "export default defineDatabase({ schema: { nuxt } })\n")
    const development = createNuxt(true, [{
      name: "vite-hub/database-replay",
      config(config: UserConfig) {
        const database = getResolvedFeatureOptions<{ projectRoot?: string }>(config, "database")
        if (database) database.projectRoot = "."
      },
    }])

    try {
      await viteHubNuxtModule({ console: { auth: false }, database: true, host: "node" }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`"file":"server/databases/default.ts"`)
      expect(generated).toContain(`"value":"runtime"`)
      expect(generated).not.toContain(`"file":"custom-server/databases/default.ts"`)
    }
    finally {
      await rm(resolve(runtimeDefinition, "../.."), { force: true, recursive: true })
      await rm(resolve(nuxtDefinition, "../.."), { force: true, recursive: true })
    }
  })

  it("uses the replay-resolved Queue configuration for the Nuxt Console", async () => {
    const replayed = createNuxt(true, [{
      name: "vite-hub/queue-replay",
      config: () => resolvedFeatures({ queue: false }),
    }])

    await viteHubNuxtModule({ comments: false, console: productionConsole, host: "node", queue: true }, replayed.nuxt)
    const replayedNitroConfig = nitroOptions(replayed.nuxt)
    await replayed.runNitroConfigHook(replayedNitroConfig)
    await expect(generatedConsoleSections()).resolves.not.toContain("queues")
    expect(nitroHandlerRoutes(replayedNitroConfig)).not.toContain("/_vitehub/api/definitions")
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.not.toContain(
      "installConsoleDefinitions",
    )
  })

  it("discovers Nuxt Console Agents and Workflows from their runtime definition roots", async () => {
    const rootWorkflow = `${tmp}/vitehub-nuxt/release.workflow.ts`
    const viteWorkflow = `${tmp}/vitehub-nuxt/app/preview.workflow.ts`
    const rootAgent = `${tmp}/vitehub-nuxt/unrelated.agent.ts`
    const viteAgent = `${tmp}/vitehub-nuxt/app/support.agent.ts`
    await mkdir(resolve(viteWorkflow, ".."), { recursive: true })
    await writeFile(rootWorkflow, "export default defineWorkflow(\"release\", async () => undefined)\n")
    await writeFile(viteWorkflow, "export default defineWorkflow(\"preview\", async () => undefined)\n")
    await writeFile(rootAgent, "export default defineAgent({})\n")
    await writeFile(viteAgent, "export default defineAgent({})\n")
    const development = createNuxt(true)
    Reflect.deleteProperty(development.nuxt.options, "serverDir")
    development.nuxt.options.vite.root = `${tmp}/vitehub-nuxt/app`

    try {
      await viteHubNuxtModule({ agent: true, console: { auth: false }, host: "node", workflow: true }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)
      let generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")

      expect(generated).toContain('"file":"release.workflow.ts","name":"release"')
      expect(generated).not.toContain('"name":"preview"')
      expect(generated).toContain('fallbackName: "support"')
      expect(generated).not.toContain('fallbackName: "unrelated"')

      await development.runBuilderWatchHook(viteAgent)
      generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain('"file":"release.workflow.ts","name":"release"')
      expect(generated).not.toContain('"name":"preview"')
      expect(generated).toContain('fallbackName: "support"')
      expect(generated).not.toContain('fallbackName: "unrelated"')
    }
    finally {
      await rm(rootWorkflow, { force: true })
      await rm(viteWorkflow, { force: true })
      await rm(rootAgent, { force: true })
      await rm(viteAgent, { force: true })
    }
  })

  it("omits implicitly disabled Netlify Workflow from the Nuxt Console", async () => {
    const implicit = createNuxt(true)

    await viteHubNuxtModule({ agent: { invocations: false }, console: { auth: false }, host: "netlify" }, implicit.nuxt)
    const implicitNitroConfig = nitroOptions(implicit.nuxt)
    await implicit.runNitroConfigHook(implicitNitroConfig)

    await expect(generatedConsoleSections()).resolves.not.toContain("workflows")
    expect(nitroHandlerRoutes(implicitNitroConfig)).not.toContain("/_vitehub/api/definitions")

    const explicit = createNuxt(true)
    await viteHubNuxtModule({
      agent: { invocations: false },
      console: { auth: false },
      host: "netlify",
      workflow: { provider: "vercel" },
    }, explicit.nuxt)
    await expect(generatedConsoleSections()).resolves.toContain("workflows")
  })

  it("reconciles the Nuxt Console from the retained KV plugin", async () => {
    const retainedKV = {
      name: "@vite-hub/kv/vite",
      api: {
        getConfig: () => ({
          kv: {
            store: { base: ".vitehub/data/kv", driver: "fs-lite" as const },
            stores: {
              default: { base: ".vitehub/data/kv", driver: "fs-lite" as const },
              sessions: { base: ".vitehub/data/sessions", driver: "fs-lite" as const },
            },
          },
        }),
      },
    }
    const retained = createNuxt(true, [retainedKV])

    await viteHubNuxtModule({ console: { auth: false }, kv: true, host: "node" }, retained.nuxt)
    await retained.runNitroConfigHook(nitroOptions(retained.nuxt))

    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toMatch(
      kvConsoleSections,
    )
  })

  it("keeps entry-discovered Console sections through Nitro replay", async () => {
    const entry = `${tmp}/vitehub-nuxt/custom-server/comments.ts`
    await mkdir(resolve(entry, ".."), { recursive: true })
    await writeFile(entry, 'throw new Error("Console discovery must not execute the Comments module")\n')
    const application = createNuxt(false)
    try {
      await viteHubNuxtModule({ console: productionConsole, host: "node" }, application.nuxt)
      expect(getConsoleSections()).toContain("comments")
      await expect(generatedConsoleSections()).resolves.toContain("comments")
      const config = nitroOptions(application.nuxt)
      for (let replay = 0; replay < 2; replay++) {
        await application.runNitroConfigHook(config)
        expect(getConsoleSections()).toContain("comments")
        await expect(generatedConsoleSections()).resolves.toContain("comments")
        expect(nitroHandlerRoutes(config)).toContain("/_vitehub/rpc")
      }
    }
    finally {
      await application.runCloseHook()
      await rm(entry, { force: true })
    }
  })

  it("does not open Console storage during CLI discovery", async () => {
    const root = `${tmp}/vitehub-nuxt-cli-discovery`
    await rm(root, { force: true, recursive: true })
    const generatedPlugin = resolve(root, ".vitehub/nitro/console/plugin.mjs")
    const activePlugin = "// active plugin\n"
    await mkdir(resolve(generatedPlugin, ".."), { recursive: true })
    await writeFile(generatedPlugin, activePlugin)
    const discovery = createNuxt(false)
    discovery.nuxt.options.rootDir = root
    discovery.nuxt.options.buildDir = resolve(root, ".nuxt")
    discovery.nuxt.options.vitehubCliDiscovery = true

    try {
      await viteHubNuxtModule({ console: { auth: false }, host: "node" }, discovery.nuxt)
      await expect(readFile(resolve(root, ".vitehub/data/console.sqlite")))
        .rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe(activePlugin)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs only discovered Workspace metadata for a Workspace-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/custom-server/workspaces/docs/config.ts`
    await mkdir(resolve(definition, "..", "workspace"), { recursive: true })
    await writeFile(
      definition,
      `export default defineWorkspace({ store: { provider: "memory" } })\nthrow new Error("The Console must not initialize Workspace Definitions during discovery.")\n`,
    )
    try {
      const development = createNuxt(true)

      await viteHubNuxtModule({ comments: false, console: productionConsole, host: "node", workspace: true }, development.nuxt)
      await development.runNitroConfigHook(nitroOptions(development.nuxt))
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","workspaces"])`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"workspaces":{"definitions":[{"fields":[{"label":"Kind","value":"Workspace Definition"},{"label":"Source root","value":"custom-server/workspaces/docs/workspace"}],"file":"custom-server/workspaces/docs/config.ts","name":"docs","source":"server-workspaces-directory-config"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not initialize")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(resolve(definition, ".."), { force: true, recursive: true })
    }
  })

  it("installs read-only Database inspection for a Database-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/custom-server/databases/default.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(
      definition,
      `export default defineDatabase({ schema: { notes, users } })\nthrow new Error("The Console must not evaluate Database Definitions during discovery.")\n`,
    )
    try {
      const development = createNuxt(true)

      await viteHubNuxtModule({ comments: false, console: productionConsole, database: true, host: "node" }, development.nuxt)
      expect(development.nuxt.options.nitro).toMatchObject({
        handlers: [{ route: "/_vitehub/rpc" }, { route: "/_vitehub" }, { route: "/_vitehub/page/session" }],
      })
      await development.runNitroConfigHook(nitroOptions(development.nuxt))
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDatabase)})`)
      expect(generated).toContain(`import("@vite-hub/database/runtime/registry")`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","databases"])`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"databases":{"definitions":[{"fields":[{"label":"Mode","value":"Default"},{"label":"Tables","value":"notes, users"}],"file":"custom-server/databases/default.ts","name":"default","source":"server-databases"}],"kind":"definition-catalog"}}, `)
      expect(generated).toContain(`installConsoleDatabase("${tmp}/vitehub-nuxt", vitehubConsoleDatabases, ["default"])`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(definition, { force: true })
    }
  })

  it("installs the Content section for the Console", async () => {
    const entry = `${tmp}/vitehub-nuxt/custom-server/content.ts`
    await mkdir(resolve(entry, ".."), { recursive: true })
    await writeFile(entry, `import { defineContent } from "vite-hub/content"\nimport { documents } from "vite-hub/content/collections"\nexport default defineContent({ workspace: "site", collections: { posts: documents({ path: "posts/*.md", fields: {} }) } })\n`)
    try {
      const development = createNuxt(true)
      await viteHubNuxtModule({ blob: true, console: { auth: false }, host: "node", workspace: true }, development.nuxt)
      expect(nitroHandlerRoutes(nitroOptions(development.nuxt))).toContain("/_vitehub/rpc")
      await expect(generatedConsoleSections()).resolves.toContain("content")
    }
    finally {
      await rm(entry, { force: true })
    }
  })

  it("turns the Database on for comments and installs the comments Nitro plugin", async () => {
    const entry = `${tmp}/vitehub-nuxt/custom-server/comments.ts`
    await mkdir(resolve(entry, ".."), { recursive: true })
    await writeFile(entry, `import { defineComments } from "vite-hub/comments"\nexport default defineComments({ authorize: () => true })\n`)
    try {
      mocks.vitehub.mockReturnValue([hubComments()])
      const { nuxt, runNitroConfigHook } = createNuxt()
      await viteHubNuxtModule({ host: "node" }, nuxt)
      expect(mocks.vitehub.mock.calls.at(-1)?.[0]).toMatchObject({ database: true })
      const config = nitroOptions(nuxt)
      await runNitroConfigHook(config)
      expect(nitroPlugins(nuxt)).toContain(`${tmp}/vitehub-nuxt/.vitehub/nitro/comments/plugin.mjs`)
      await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/comments/plugin.mjs`, "utf8")).resolves.toContain("defineCommentsPlugin({")

      // An explicit `database: false` is never overridden.
      await viteHubNuxtModule({ database: false, host: "node" }, createNuxt().nuxt)
      expect(mocks.vitehub.mock.calls.at(-1)?.[0]).toMatchObject({ database: false })
    }
    finally {
      await rm(entry, { force: true })
    }
  })

  it("installs only discovered Queue metadata for a Queue-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/custom-server/queues/email.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(
      definition,
      `throw new Error("The Console must not evaluate Queue Definitions during discovery.")\n`,
    )
    try {
      const development = createNuxt(true)

      await viteHubNuxtModule({ comments: false, console: productionConsole, host: "node", queue: true }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)
      expect(nitroConfig).toMatchObject({
        handlers: [
          { handler: "server/handler.ts", route: "/api/example" },
          { route: "/_vitehub/rpc" },
          { route: "/_vitehub" },
          { route: "/_vitehub/page/session" },
        ],
      })
      expect(development.nuxt.options.vite.plugins).not.toContainEqual(expect.objectContaining({ name: "vite-hub/console-invocation-root" }))
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","queues"])`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"queues":{"definitions":[{"fields":[],"file":"custom-server/queues/email.ts","name":"email","source":"server-queues"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(definition, { force: true })
    }
  })

  it("discovers Nuxt Queue Definitions from the Queue runtime root", async () => {
    const rootQueue = `${tmp}/vitehub-nuxt/email.queue.ts`
    const viteQueue = `${tmp}/vitehub-nuxt/app/preview.queue.ts`
    await mkdir(resolve(viteQueue, ".."), { recursive: true })
    await writeFile(rootQueue, "export default defineQueue({})\n")
    await writeFile(viteQueue, "export default defineQueue({})\n")
    const development = createNuxt(true)
    Reflect.deleteProperty(development.nuxt.options, "serverDir")
    development.nuxt.options.vite.root = `${tmp}/vitehub-nuxt/app`

    try {
      await viteHubNuxtModule({ console: { auth: false }, host: "node", queue: true }, development.nuxt)
      await development.runNitroConfigHook(nitroOptions(development.nuxt))

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain('"file":"email.queue.ts"')
      expect(generated).toContain('"file":"app/preview.queue.ts"')
    }
    finally {
      await rm(rootQueue, { force: true })
      await rm(viteQueue, { force: true })
    }
  })

  it("installs only discovered Rate Limit policies for a Rate-Limit-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/packages/policies/rules/upload.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(
      definition,
      [
        'import { requireRateLimit } from "vite-hub/rate-limit"',
        'requireRateLimit(event, "uploads", { enforcement: "strict", failure: "allow", limit: 25, window: "10s" })',
        'throw new Error("The Console must not evaluate Rate Limit modules during discovery.")',
        "",
      ].join("\n"),
    )
    try {
      const development = createNuxt(true)
      await viteHubNuxtModule({
        comments: false, console: productionConsole,
        host: "node",
        rateLimit: { projectRoot: "packages/policies", scanDirs: ["rules"] },
      }, development.nuxt)
      await development.runNitroConfigHook(nitroOptions(development.nuxt))
      expect(development.nuxt.options.nitro).toMatchObject({
        handlers: [
          { handler: "server/handler.ts", route: "/api/example" },
          { route: "/_vitehub/rpc" },
          { route: "/_vitehub" },
          { route: "/_vitehub/page/session" },
        ],
      })
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","rate-limits"])`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"rate-limits":{"definitions":[{"fields":[{"label":"Limit","value":"25"},{"label":"Window","value":"10s"},{"label":"Enforcement","value":"Strict"},{"label":"Provider failure","value":"Allow"},{"label":"Source location","value":"2:1"}],"file":"packages/policies/rules/upload.ts","name":"uploads","source":"require-rate-limit"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(definition, { force: true })
    }
  })

  it("installs discovered Schedule timing metadata for a Schedule-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/custom-server/schedules/daily.ts`
    await mkdir(resolve(definition, ".."), { recursive: true })
    await writeFile(
      definition,
      `export default defineSchedule({ cron: "0 9 * * *", handler() { throw new Error("The Console must not evaluate Schedule Definitions during discovery.") } })\n`,
    )
    try {
      const development = createNuxt(true)

      await viteHubNuxtModule({ comments: false, console: productionConsole, host: "node", schedule: true }, development.nuxt)
      const nitroConfig = nitroOptions(development.nuxt)
      await development.runNitroConfigHook(nitroConfig)
      expect(nitroConfig).toMatchObject({
        handlers: [
          { handler: "server/handler.ts", route: "/api/example" },
          { route: "/_vitehub/rpc" },
          { route: "/_vitehub" },
          { route: "/_vitehub/page/session" },
        ],
      })
      expect(development.nuxt.options.vite.plugins).not.toContainEqual(expect.objectContaining({ name: "vite-hub/console-invocation-root" }))
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections("${tmp}/vitehub-nuxt", ["setup","env","schedules"])`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"schedules":{"kind":"record-table","records":[{"cells":{"manual":"Disabled","schedule":"daily","timing":"0 9 * * *"},"fields":[{"label":"Kind","value":"Static schedule"},{"label":"Cron","value":"0 9 * * *"},{"label":"Time zone","value":"UTC"},{"label":"File","value":"custom-server/schedules/daily.ts"},{"label":"Source","value":"server-schedules"},`)
      expect(generated).toContain(`{ readScheduleConsoleRecords: vitehubConsoleRuntimeReader0 }`)
      expect(generated).toMatch(/import\("[^"]*[\\/]schedule[\\/](?:src|dist)[\\/]runtime[\\/]console\.(?:ts|js)"\)/)
      expect(generated).toContain(`{ "schedules": vitehubConsoleRuntimeReader0 }`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(definition, { force: true })
    }
  })

  it("keeps Schedule inspection on the runtime root when replay changes config", async () => {
    const runtimeDefinition = `${tmp}/vitehub-nuxt/custom-server/schedules/runtime.ts`
    const replayedDefinition = `${tmp}/vitehub-nuxt/replayed/schedules/inactive.ts`
    await mkdir(resolve(runtimeDefinition, ".."), { recursive: true })
    await mkdir(resolve(replayedDefinition, ".."), { recursive: true })
    await writeFile(runtimeDefinition, `export default defineSchedule({ cron: "0 9 * * *", handler() {} })\n`)
    await writeFile(replayedDefinition, `export default defineSchedule({ cron: "0 10 * * *", handler() {} })\n`)
    const development = createNuxt(true, [{
      name: "vite-hub/schedule-replay",
      config(config: UserConfig & { schedule?: { projectRoot?: string } }) {
        config.schedule = { projectRoot: "replayed" }
      },
    }])

    try {
      await viteHubNuxtModule({
        console: { auth: false },
        host: "node",
        schedule: { projectRoot: "custom-server" },
      }, development.nuxt)
      await development.runNitroConfigHook(nitroOptions(development.nuxt))

      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`{"label":"File","value":"custom-server/schedules/runtime.ts"}`)
      expect(generated).not.toContain(`{"label":"File","value":"replayed/schedules/inactive.ts"}`)
    }
    finally {
      await rm(resolve(runtimeDefinition, "../.."), { force: true, recursive: true })
      await rm(resolve(replayedDefinition, "../.."), { force: true, recursive: true })
    }
  })

  it("installs discovered Sandbox metadata for a Sandbox-only Console", async () => {
    const definition = `${tmp}/vitehub-nuxt/preview.sandbox-task.ts`
    await writeFile(definition, `export default defineSandboxTask({ handler: async () => { throw new Error("must not run") } })\n`)
    try {
      const development = createNuxt(true)

      await viteHubNuxtModule({ comments: false, console: productionConsole, host: "cloudflare", sandboxTask: true }, development.nuxt)
      await development.runNitroConfigHook(nitroOptions(development.nuxt))
      const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleDefinitions("${tmp}/vitehub-nuxt", {"sandbox-tasks":{"definitions":[{"fields":[{"label":"Kind","value":"Definition"}],"file":"preview.sandbox-task.ts","name":"preview","source":"vite-suffix"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("must not run")
    }
    finally {
      await rm(definition, { force: true })
    }
  })

  it("rejects host-managed production Console on non-Node hosts", async () => {
    const development = createNuxt(true)
    await expect(viteHubNuxtModule({ agent: true, console: { auth: false }, host: "cloudflare" }, development.nuxt)).resolves.toBeUndefined()
    expect(development.nuxt.options.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/rpc" }))

    const production = createNuxt(false)
    await expect(viteHubNuxtModule({
      agent: true,
      console: { auth: false, authorize: hostManagedAuthorize },
      host: "cloudflare",
    }, production.nuxt)).rejects.toMatchObject({ code: "VITE_HUB_B0022" })
  })

  it("passes host-managed invocation into the Nuxt Console plugin", async () => {
    const production = createNuxt(false)
    await viteHubNuxtModule({
      agent: true,
      console: { ...productionConsole, invoke: true },
      host: "node",
    }, production.nuxt)
    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).toContain("invoke: true")
    // The Console reads the Agent journal. It does not configure one.
    expect(generated).not.toContain("observations")
    expect(generated).not.toContain("retention")
  })

  it.each(["databaseUrl", "observations", "retention"])("rejects the removed console.%s option in Nuxt", async (key) => {
    await expect(viteHubNuxtModule({
      agent: true,
      console: { ...productionConsole, [key]: {} },
      host: "node",
    }, createNuxt(true).nuxt)).rejects.toThrow(`agent: { invocations: { ${key} } }`)
  })

  it.each([undefined, `${tmp}/vitehub-nuxt/persistent data`])("takes signed calls for bare Console enablement with dataDir %s", async (dataDir) => {
    const production = createNuxt(false)
    await expect(viteHubNuxtModule({ console: true, host: "node", dataDir }, production.nuxt)).resolves.toBeUndefined()
    await expect(readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).resolves.toContain('installConsoleAccess({ mode: "token" })')
    await expect(viteHubNuxtModule({ console: JSON.parse('{"auth":"app"}'), host: "node", dataDir }, createNuxt(true).nuxt))
      .rejects.toMatchObject({ code: "VITE_HUB_B0020" })
  })

  it("rejects a production Console without sign-in", async () => {
    await expect(viteHubNuxtModule({ console: { auth: false }, host: "node" }, createNuxt(false).nuxt))
      .rejects.toMatchObject({ code: "VITE_HUB_B0022" })
    await expect(viteHubNuxtModule({ console: { auth: false }, host: "node" }, createNuxt(true).nuxt)).resolves.toBeUndefined()
  })

  it.each(["_prepare", "vitehubCliDiscovery"])("allows auth: false during Nuxt %s", async (key) => {
    const { nuxt } = createNuxt(false)
    Object.assign(nuxt.options, { [key]: true })
    await expect(viteHubNuxtModule({ console: { auth: false }, host: "node" }, nuxt)).resolves.toBeUndefined()
  })

  it("discovers callback-backed Auth policy for a production Console", async () => {
    const authDefinition = `${tmp}/vitehub-nuxt/custom-server/auth.ts`
    await mkdir(resolve(authDefinition, ".."), { recursive: true })
    await writeFile(authDefinition, `
      export default defineAuth({
        access: { routes: [
          { route: "/_vitehub/**", authorize: authorizeConsole },
          { route: "/_vitehub/api/**", authorize: authorizeConsole },
        ] },
      })
    `)
    try {
      const production = createNuxt(false)

      await expect(viteHubNuxtModule({
        auth: true,
        console: true,
        host: "node",
      }, production.nuxt)).resolves.toBeUndefined()

      expect(nitroOptions(production.nuxt).handlers).toEqual(expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/rpc" })]))
      // Impersonation opens with a one-time link on /_vitehub/rpc, so Auth adds no Console route.
      expect(nitroHandlerRoutes(nitroOptions(production.nuxt))).not.toContain("/_vitehub/auth/manage")
      const replayed: Record<string, unknown> = {}
      for (const hook of production.nitroConfigHooks) await hook(replayed)
      expect(replayed.handlers).toEqual(expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/rpc" })]))
      expect(nitroHandlerRoutes(replayed)).not.toContain("/_vitehub/auth/manage")
      for (const config of [nitroOptions(production.nuxt), replayed]) {
        expect(nitroHandlerRoutes(config).filter(route => route?.startsWith("/.well-known/"))).toEqual([])
      }
    } finally {
      await rm(authDefinition, { force: true })
    }
  })

  it.each(["node", "cloudflare"] as const)("generates Connections production Nitro output for %s", async (preset) => {
    const { viteHubPlugins: vitehub } = await vi.importActual<typeof import("../src/plugins.ts")>("../src/plugins.ts")
    mocks.vitehub.mockImplementation((options: Parameters<typeof vitehub>[0]) => vitehub(options).filter(
      plugin => isTestRecord(plugin) && ["vite-hub/deployment-host", "@vite-hub/connections/vite"].includes(String(plugin.name)),
    ))
    const production = createNuxt(false)
    const definition = `${tmp}/vitehub-nuxt/custom-server/connections/mail.ts`
    const actor = `${tmp}/vitehub-nuxt/custom-server/connections-actor.ts`
    const generatedDir = `${tmp}/vitehub-nuxt/.vitehub/nitro/connections`
    await mkdir(dirname(definition), { recursive: true })
    // The Connections management API is the app's own API, so the app names who may manage Connections.
    await writeFile(actor, "export default () => \"user:owner\"\n")
    await writeFile(definition, `import { apiKey, defineConnection } from "vite-hub/connections"
export default defineConnection({ provider: apiKey({ origins: ["https://api.example.com"] }) })
`)
    await rm(generatedDir, { recursive: true, force: true })
    try {
      await viteHubNuxtModule({
        connections: { management: { actor } },
        database: preset === "cloudflare" ? { databaseId: "connections-id", databaseName: "connections" } : true,
        console: productionConsole,
        host: preset,
      }, production.nuxt)
      const config = nitroOptions(production.nuxt)
      await production.runNitroConfigHook(config)
      expect(config.preset).toBe(preset === "node" ? "node-server" : "cloudflare-module")
      const registry = resolve(generatedDir, "registry.ts")
      const handler = resolve(generatedDir, "handler.ts")
      expect(config.alias).toMatchObject({ "#vitehub/connections/registry": registry })
      expect(config.noExternals).toEqual(expect.arrayContaining(["vite-hub", "@vite-hub/"]))
      expect(await readFile(registry, "utf8")).toContain(`registry["mail"] = () => import(${JSON.stringify(definition)})`)
      expect(config.handlers).toEqual(expect.arrayContaining([
        { handler, method: "post", route: "/_vitehub/connections" },
        { handler, method: "get", route: "/_vitehub/connections/connect/**" },
        { handler, method: "get", route: "/_vitehub/connections/callback" },
      ]))
      // Resolve generated imports, including the app's actor module and the discovered Connection.
      const output = await build({
        // SAFETY: Nitro aliases map virtual module names to generated module paths.
        alias: config.alias as Record<string, string>,
        bundle: true,
        entryPoints: [registry, handler],
        format: "esm",
        outdir: resolve(generatedDir, "bundled"),
        packages: "external",
        platform: preset === "node" ? "node" : "neutral",
        write: false,
      })
      expect(output.outputFiles.map(file => file.text).join("\n")).toContain("https://api.example.com")
      expect(output.outputFiles.map(file => file.text).join("\n")).toContain("createConnectionsHandler")
    }
    finally {
      await production.runCloseHook()
      await rm(definition, { force: true })
      await rm(actor, { force: true })
    }
  })

  it("adds no Console section or Console actor for the Connections management API", async () => {
    const development = createNuxt(true)
    development.nuxt.options.vite.root = `${tmp}/vitehub-nuxt/app`
    await viteHubNuxtModule({
      connections: { management: true },
      database: true,
      console: { auth: false, authorize: hostManagedAuthorize },
      host: "node",
    }, development.nuxt)
    const config = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(config)

    await expect(generatedConsoleSections()).resolves.not.toContain("connections")
    expect(config.alias).not.toHaveProperty("#vitehub/console/connections-actor")
  })

  it("mounts the Console routes below the Nitro base, which is the Nuxt app base URL", async () => {
    const production = createNuxt(false)
    Object.assign(production.nuxt.options, { app: { baseURL: "/portal/" } })
    await viteHubNuxtModule({ console: productionConsole, host: "node" }, production.nuxt)
    await production.runNitroConfigHook(nitroOptions(production.nuxt))

    const config = nitroOptions(production.nuxt)
    expect(production.nuxt.options.vite).toHaveProperty("__vitehubAppBaseURL", "/portal/")
    expect(mocks.objectHook).toHaveBeenCalledWith(expect.objectContaining({ __vitehubAppBaseURL: "/portal/" }), expect.anything())
    expect(nitroHandlerRoutes(config)).toContain("/_vitehub/rpc")
    expect(nitroHandlerRoutes(config)).not.toContain("/_vitehub/**")
    expect(nitroHandlerRoutes(config).filter(route => route?.startsWith("/portal"))).toEqual([])
    expect(config.publicAssets).not.toContainEqual(expect.objectContaining({ baseURL: "/_vitehub/assets" }))
    const plugin = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(plugin).toContain('installConsolePageTool(nitroApp, { base: "/portal/"')
  })

  it.each([false, undefined] as const)("leaves application OAuth discovery routes alone with console.auth %j", async (auth) => {
    const application = createNuxt(auth === false)
    const applicationHandlers = [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/**",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/**",
    ].map((route, index) => ({ handler: `/application/discovery-${index}.js`, route }))
    application.nuxt.options.nitro.handlers = [...applicationHandlers]
    await viteHubNuxtModule({ console: auth === false ? { auth, authorize: hostManagedAuthorize } : { authorize: hostManagedAuthorize }, host: "node" }, application.nuxt)
    const config = nitroOptions(application.nuxt)
    expect(config.handlers).toEqual(expect.arrayContaining(applicationHandlers))
    // The default replay fixture replaces all handlers; model an app that keeps its discovery routes instead.
    mocks.objectHook.mockImplementationOnce(config => ({ nitro: { ...config.nitro, handlers: [...applicationHandlers] } }))
    await application.runNitroConfigHook(config)
    expect(config.handlers).toEqual(expect.arrayContaining(applicationHandlers))
    expect(nitroHandlerRoutes(config).filter(route => route?.startsWith("/.well-known/"))).toEqual(applicationHandlers.map(handler => handler.route))
    expect(nitroHandlerRoutes(config)).not.toContain("/_vitehub/mcp")
  })

  it("resolves Console file paths from the Nuxt rootDir when the Vite root is the app folder", async () => {
    const authorize = `${tmp}/vitehub-nuxt/server/console-authorize.ts`
    await mkdir(`${tmp}/vitehub-nuxt/server`, { recursive: true })
    await writeFile(authorize, "export default () => true\n")
    try {
      // Nuxt sets the Vite root to srcDir, which is `app/` in a Nuxt app.
      const production = createNuxt(false)
      production.nuxt.options.vite.root = production.nuxt.options.srcDir
      await viteHubNuxtModule({ console: { authorize: "./server/console-authorize.ts" }, host: "node" }, production.nuxt)
      await production.runNitroConfigHook(nitroOptions(production.nuxt))
      expect(await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).toContain(pathToFileURL(authorize).href)
    }
    finally {
      await rm(authorize, { force: true })
      await rm(`${tmp}/vitehub-nuxt/app/.vitehub`, { force: true, recursive: true })
    }
  })

  it("uses the normalized relative Vite root for Auth assertion and middleware", async () => {
    const authDefinition = `${tmp}/vitehub-nuxt/frontend/server/auth.ts`
    await mkdir(resolve(authDefinition, ".."), { recursive: true })
    await writeFile(authDefinition, `
      export default defineAuth({
        access: { routes: [
          { route: "/_vitehub/**", authorize: authorizeConsole },
          { route: "/_vitehub/api/**", authorize: authorizeConsole },
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
        console: true,
        host: "node",
      }, production.nuxt)
      const nitroConfig: Record<string, unknown> = {}
      await production.runNitroConfigHook(nitroConfig)

      expect(nitroConfig).toMatchObject({
        handlers: expect.arrayContaining([expect.objectContaining({ route: "/api/auth/**" })]),
      })
      expect(authConfig).toHaveBeenCalledWith(
        expect.objectContaining({ root: `${tmp}/vitehub-nuxt/frontend` }),
        expect.anything(),
      )
    }
    finally {
      await rm(`${tmp}/vitehub-nuxt/frontend`, { force: true, recursive: true })
    }
  })

  it("does not install the console when the option is omitted", async () => {
    const { nuxt } = createNuxt(true)
    await viteHubNuxtModule({ host: "node" }, nuxt)

    expect(nuxt.options.nitro).not.toHaveProperty("handlers")
    expect(nuxt.options.nitro).not.toHaveProperty("publicAssets")
    expect(nuxt.options.routeRules).toEqual({})
  })

  it("does not install the console when explicitly disabled", async () => {
    const { nuxt } = createNuxt(true)
    await viteHubNuxtModule({ console: false, host: "node" }, nuxt)

    expect(nuxt.options.nitro).not.toHaveProperty("handlers")
    expect(nuxt.options.nitro).not.toHaveProperty("publicAssets")
    expect(nuxt.options.routeRules).toEqual({})
    expect(nuxt.options.vite.plugins).not.toContainEqual(
      expect.objectContaining({ name: "vite-hub/console-invocation-root" }),
    )
  })

  it.each([
    ["cloudflare", "cloudflare-module"],
    ["vercel", "vercel"],
  ] as const)("exposes the %s Nitro preset during Nuxt module setup", async (preset, nitroPreset) => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ host: preset }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({ preset: nitroPreset })
  })

  it.each([
    ["deno", false, "deno-server"],
    ["cloudflare", true, "cloudflare-module"],
  ] as const)("uses the Nitro 3 preset for %s with realtime %s", async (preset, realtime, expectedPreset) => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    await viteHubNuxtModule({ console: false, host: preset, realtime }, nuxt)
    expect(nitroOptions(nuxt).preset).toBe(expectedPreset)
    const config: Record<string, unknown> = { ...nitroOptions(nuxt) }
    await runNitroConfigHook(config)
    await runNitroConfigHook(config)
    expect(mocks.sandboxTaskHook).toHaveBeenCalledWith(expect.objectContaining({ [VITEHUB_NITRO_CONFIG_CONTEXT]: true }), expect.anything())
  })

  it("detects the Nitro preset from the host's build variables when host is omitted", async () => {
    for (const name of ["VITEHUB_HOST", "NITRO_PRESET", "SERVER_PRESET", "WORKERS_CI", "NETLIFY", "NOW_BUILDER", "VERCEL_ENV", "DENO_DEPLOY", "DENO_DEPLOYMENT_ID"]) vi.stubEnv(name, "")
    vi.stubEnv("VERCEL", "1")
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({}, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({ preset: "vercel" })
  })

  it("rejects a conflicting Nitro preset during Nuxt module setup", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, { nitro: { preset: "vercel" } })

    await expect(viteHubNuxtModule({ host: "cloudflare" }, nuxt)).rejects.toThrow(
      'vitehub host "cloudflare" conflicts with nitro.preset "vercel"',
    )
  })

  it("defaults Cloudflare WASM loading to lazy during Nuxt module setup", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({ wasm: { lazy: true } })
  })

  it("resolves the module export condition in Cloudflare builds only", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, { nitro: { exportConditions: ["custom"] } })
    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
    expect(nitroOptions(nuxt)).toMatchObject({ exportConditions: ["custom", "module"] })

    const development = createNuxt(true)
    await viteHubNuxtModule({ host: "cloudflare" }, development.nuxt)
    expect(nitroOptions(development.nuxt)).not.toHaveProperty("exportConditions")

    const { nuxt: vercelNuxt } = createNuxt()
    await viteHubNuxtModule({ host: "vercel" }, vercelNuxt)
    expect(nitroOptions(vercelNuxt)).not.toHaveProperty("exportConditions")
  })

  // Nitro 3 maps the Cloudflare preset to `cloudflare-dev` in development, and that preset defaults to the workerd runner.
  it("keeps Nuxt development with the Cloudflare host on Nitro's Node runner", async () => {
    vi.stubEnv("NITRO_DEV_RUNNER", "")
    const development = createNuxt(true)
    await viteHubNuxtModule({ host: "cloudflare", realtime: true }, development.nuxt)
    expect(nitroOptions(development.nuxt)).toMatchObject({ devServer: { runner: "node-worker" }, preset: "cloudflare-module" })

    const chosen = createNuxt(true)
    Object.assign(chosen.nuxt.options, { nitro: { devServer: { runner: "miniflare" } } })
    await viteHubNuxtModule({ host: "cloudflare" }, chosen.nuxt)
    expect(nitroOptions(chosen.nuxt)).toMatchObject({ devServer: { runner: "miniflare" } })

    const production = createNuxt()
    await viteHubNuxtModule({ host: "cloudflare" }, production.nuxt)
    expect(nitroOptions(production.nuxt)).not.toHaveProperty("devServer")

    for (const runner of ["node-worker", "miniflare"]) {
      vi.stubEnv("NITRO_DEV_RUNNER", runner)
      const fromEnv = createNuxt(true)
      await viteHubNuxtModule({ host: "cloudflare" }, fromEnv.nuxt)
      expect(nitroOptions(fromEnv.nuxt)).toMatchObject({ devServer: { runner } })

      const explicit = createNuxt(true)
      Object.assign(explicit.nuxt.options, { nitro: { devServer: { runner: "custom-runner" } } })
      await viteHubNuxtModule({ host: "cloudflare" }, explicit.nuxt)
      expect(nitroOptions(explicit.nuxt)).toMatchObject({ devServer: { runner: "custom-runner" } })
    }
  })

  it.each([undefined, false, true])("defaults Cloudflare deployment output while preserving an explicit %s setting", async (deployConfig) => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, { nitro: { cloudflare: { deployConfig, wrangler: { name: "existing-worker" } } } })

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({
      cloudflare: { deployConfig: deployConfig ?? true, wrangler: { name: "existing-worker" } },
    })
  })

  // Nitro adds `nodejs_compat` itself. ViteHub only turns Node compatibility off when the app opts out.
  describe("Node compatibility flags", () => {
    async function configured(inline: string[], project?: string[]) {
      const rootDir = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-node-compat-"))
      try {
        if (project) await writeFile(resolve(rootDir, "wrangler.json"), JSON.stringify({ compatibility_flags: project }))
        const { nuxt, runNitroConfigHook } = createNuxt()
        const config: { cloudflare: { nodeCompat: boolean, wrangler: Record<string, unknown> }, modules?: unknown[], rootDir: string } = {
          cloudflare: { nodeCompat: true, wrangler: { compatibility_flags: [...inline] } },
          rootDir,
        }
        await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
        await runNitroConfigHook(config)
        await runNitroConfigHook(config)
        return config
      }
      finally {
        await rm(rootDir, { force: true, recursive: true })
      }
    }

    it.each([
      ["no flags", [], undefined, true],
      ["other inline flags", ["custom"], undefined, true],
      ["an inline nodejs_compat", ["nodejs_compat"], undefined, true],
      ["a project nodejs_compat_v2", [], ["nodejs_compat_v2"], true],
      ["an inline no_nodejs_compat", ["no_nodejs_compat"], undefined, false],
      ["a project no_nodejs_compat", [], ["no_nodejs_compat"], false],
    ] as const)("keeps the app's flags for %s", async (_label, inline, project, nodeCompat) => {
      const config = await configured([...inline], project && [...project])
      expect(config.cloudflare.wrangler.compatibility_flags).toEqual([...inline])
      expect(config.cloudflare.nodeCompat).toBe(nodeCompat)
    })

    it("leaves the flags alone without nodeCompat", async () => {
      const { nuxt, runNitroConfigHook } = createNuxt()
      const config = { cloudflare: { nodeCompat: false, wrangler: { compatibility_flags: ["custom"] } } }
      await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
      await runNitroConfigHook(config)
      expect(config.cloudflare.wrangler.compatibility_flags).toEqual(["custom"])
    })
  })

  it("passes generated server Env to Wrangler while preserving an explicit alias", async () => {
    for (const override of [undefined, "/custom/env.mjs"]) {
      const { nuxt, runNitroConfigHook } = createNuxt()
      const config: Record<string, unknown> = { cloudflare: { wrangler: { alias: override ? { "#vitehub/env/server": override } : {} } } }
      await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
      await runNitroConfigHook(config)
      expect(config).toHaveProperty("cloudflare.wrangler.alias.#vitehub/env/server", override ?? `${tmp}/vitehub-nuxt/.vitehub/env/server.mjs`)
    }
  })

  it.each([undefined, "/wrangler/env.mjs"])("passes a Nitro server Env override to Wrangler while preserving its explicit alias %s", async (wranglerOverride) => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    nuxt.options.nitro.alias = { "#vitehub/env/server": "/nitro/env.mjs" }
    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
    const config = nitroOptions(nuxt)
    config.cloudflare = { wrangler: { alias: wranglerOverride ? { "#vitehub/env/server": wranglerOverride } : {} } }
    for (let replay = 0; replay < 2; replay++) {
      await runNitroConfigHook(config)
      expect(config).toHaveProperty("alias.#vitehub/env/server", "/nitro/env.mjs")
      expect(config).toHaveProperty("cloudflare.wrangler.alias.#vitehub/env/server", wranglerOverride ?? "/nitro/env.mjs")
    }
  })

  it.each([
    ["json", JSON.stringify({ alias: { "#vitehub/env/server": "/project/env.mjs" } })],
    ["jsonc", '{ // Project Env implementation\n "alias": { "#vitehub/env/server": "/project/env.mjs" }, }'],
    ["toml", '[alias]\n"#vitehub/env/server" = "/project/env.mjs"'],
  ])("preserves a project Wrangler Env alias from wrangler.%s", async (extension, contents) => {
    const rootDir = await mkdtemp("/tmp/vitehub-nuxt-wrangler-")
    try {
      await writeFile(resolve(rootDir, `wrangler.${extension}`), contents)
      await mkdir(resolve(rootDir, "app"))
      for (const override of [undefined, "/inline/env.mjs"]) {
        const { nuxt, runNitroConfigHook } = createNuxt()
        const config: Record<string, unknown> = {
          rootDir: resolve(rootDir, "app"),
          cloudflare: { wrangler: { alias: override ? { "#vitehub/env/server": override } : {} } },
        }
        await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
        await runNitroConfigHook(config)
        expect(config).toHaveProperty("cloudflare.wrangler.alias.#vitehub/env/server", override ?? "/project/env.mjs")
        await runNitroConfigHook(config)
        expect(config).toHaveProperty("cloudflare.wrangler.alias.#vitehub/env/server", override ?? "/project/env.mjs")
      }
    }
    finally {
      await rm(rootDir, { force: true, recursive: true })
    }
  })

  it("preserves explicit Nuxt WASM loading and leaves other presets unchanged", async () => {
    const { nuxt: cloudflareNuxt } = createNuxt()
    Object.assign(cloudflareNuxt.options, { nitro: { wasm: { lazy: false } } })

    await viteHubNuxtModule({ host: "cloudflare" }, cloudflareNuxt)

    expect(nitroOptions(cloudflareNuxt)).toMatchObject({ wasm: { lazy: false } })

    const { nuxt: vercelNuxt } = createNuxt()
    await viteHubNuxtModule({ host: "vercel" }, vercelNuxt)

    expect(nitroOptions(vercelNuxt)).not.toHaveProperty("wasm")
  })

  it.each([false, true])("filters command-only plugins from replay hooks and config.plugins (dev: %s)", async (dev) => {
    const serve: Plugin = { name: "vite-hub/serve-only", apply: "serve", config: vi.fn(() => undefined) }
    const build: Plugin = { name: "vite-hub/build-only", apply: "build", config: vi.fn(() => undefined) }
    const observer: Plugin = {
      name: "vite-hub/observer",
      config(config) {
        expect(config.plugins).toContain(dev ? serve : build)
        expect(config.plugins).not.toContain(dev ? build : serve)
      },
    }
    mocks.vitehub.mockReturnValue([serve, build, observer])
    const { nuxt, runNitroConfigHook } = createNuxt(dev)
    await viteHubNuxtModule({ host: "node" }, nuxt)
    await runNitroConfigHook({})

    expect((dev ? serve : build).config).toHaveBeenCalledOnce()
    expect((dev ? build : serve).config).not.toHaveBeenCalled()
  })

  it.each(["installed", "existing"] as const)("preserves Vite's functional apply selection for %s replay plugins", async (source) => {
    let calls = 0
    const apply = vi.fn((config: UserConfig) => ++calls === 1 && config.mode === "production")
    const hook = vi.fn((_config: UserConfig) => undefined)
    const plugin: Plugin = { name: "vite-hub/selected", apply, config: hook }
    const selected = await resolveConfig({ configFile: false, plugins: [plugin] }, "build", "production")
    expect(selected.plugins).toContain(plugin)
    hook.mockClear()

    mocks.vitehub.mockReturnValue(source === "installed" ? [plugin] : [])
    const { nuxt, runNitroConfigHook } = createNuxt(false, source === "existing" ? [plugin] : [])
    await viteHubNuxtModule({ host: "node" }, nuxt)
    await runNitroConfigHook({})

    expect(apply).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledOnce()
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ plugins: expect.arrayContaining([plugin]) }), expect.anything())
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

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(
      (
        // SAFETY: The output plugin records its generated root on the mutable Vite configuration.
        nuxt.options.vite as typeof nuxt.options.vite & {
          [VITEHUB_GENERATED_ROOT]?: string
        }
      )[VITEHUB_GENERATED_ROOT],
    ).toBe(`${tmp}/vitehub-nuxt/.nuxt/vitehub`)
    expect(
      (
        // SAFETY: The output plugin records its server directories on the mutable Vite configuration.
        nuxt.options.vite as typeof nuxt.options.vite & {
          [VITEHUB_SERVER_DIRS]?: string[]
        }
      )[VITEHUB_SERVER_DIRS],
    ).toEqual([`${tmp}/vitehub-nuxt/custom-server`])
    // SAFETY: Nuxt normalizes configured Vite plugins to an array before module setup completes.
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
      expect.objectContaining({ name: "vite-hub/deployment-host" }),
      expect.objectContaining({ name: "@vite-hub/agent/vite" }),
      existingQueuePlugin,
      expect.objectContaining({ name: "@vite-hub/sandbox/task/vite" }),
      expect.objectContaining({ name: "@vite-hub/workflow/vite" }),
      existingPlugin,
      expect.objectContaining({ name: "@vite-hub/env/vite" }),
      existingOwnerPlugin,
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
      projectRoot: `${tmp}/vitehub-nuxt`,
      root: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
      viteConfig: expect.objectContaining({ queue: { namePrefix: "vitehub-nuxt-" } }),
    })
    expect(mocks.workflowNitroConfig).toHaveBeenCalledWith({
      nitro: expect.objectContaining({ preset: "cloudflare_module" }),
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
      transformRegistry: mocks.agentWorkflowRegistryTransform,
    })
    expect(mocks.queueNitroConfig).not.toHaveBeenCalled()
    expect(mocks.existingOwnerConfig).toHaveBeenCalledOnce()
    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_GENERATED_ROOT]: `${tmp}/vitehub-nuxt/.nuxt/vitehub`,
        [VITEHUB_SERVER_DIRS]: [`${tmp}/vitehub-nuxt/custom-server`],
      }),
      expect.anything(),
    )
    expect(mocks.sandboxTaskHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
        [VITEHUB_PROJECT_ROOT]: `${tmp}/vitehub-nuxt`,
      }),
      expect.anything(),
    )
    expect(mocks.objectHook).toHaveBeenCalledWith(
      expect.objectContaining({
        nitro: expect.objectContaining({ preset: "cloudflare_module" }),
        resolve: {
          alias: {
            "#vitehub/env/description": `${tmp}/vitehub-nuxt/.vitehub/env/description.mjs`,
            "#vitehub/env/public": `${tmp}/vitehub-nuxt/.vitehub/env/public.mjs`,
            "#vitehub/env/server": `${tmp}/vitehub-nuxt/.vitehub/env/server.mjs`,
            "~": `${tmp}/vitehub-nuxt/app`,
          },
        },
        root: `${tmp}/vitehub-nuxt`,
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
        "cloudflare:workers": `${tmp}/vitehub-nuxt/.nuxt/vitehub/cloudflare-workers.dev.mjs`,
        "#vitehub/env/description": `${tmp}/vitehub-nuxt/.vitehub/env/description.mjs`,
        "#vitehub/env/public": `${tmp}/vitehub-nuxt/.vitehub/env/public.mjs`,
        "#vitehub/env/server": `${tmp}/vitehub-nuxt/.vitehub/env/server.mjs`,
        "#vitehub/kv/config": `${tmp}/vitehub-nuxt/.vitehub/nuxt/disabled-kv-config.mjs`,
        "@vite-hub/kv/runtime/redis-driver": expect.stringMatching(/[\\/]internal[\\/]disabled-redis-driver\.(?:ts|js)$/),
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/[\\/]internal[\\/]disabled-upstash-driver\.(?:ts|js)$/),
      },
      cloudflare: {
        wrangler: {
          alias: { "#vitehub/env/server": `${tmp}/vitehub-nuxt/.vitehub/env/server.mjs` },
          d1_databases: [d1Binding, d1Binding],
          name: "vitehub-nuxt",
          observability: { enabled: true },
          secrets: { required: ["VITEHUB_TOKEN"] },
        },
      },
      ownerPlugin: true,
      handlers: [{ handler: "server/handler.ts", route: "/api/example" }],
      modules: ["agent-module"],
      noExternals: ["vite-hub", "@vite-hub/", `${tmp}/vitehub-nuxt/.vitehub`, h3RuntimeRoot],
      preset: "cloudflare_module",
      queues: {
        handlers: [{ handler: "custom-server/queues/email.ts" }],
      },
      replace: {
        __VITEHUB_AGENT_APP_ROOT__: JSON.stringify(`${tmp}/vitehub-nuxt`),
      },
      rollupConfig: {
        plugins: [
          expect.objectContaining({ name: "vite-hub/nitro-cloudflare-workers-dev" }),
          expect.objectContaining({ name: "vite-hub/console-operation-features" }),
          expect.objectContaining({ name: "vite-hub/nitro-optional-peers" }),
          expect.objectContaining({ name: "vite-hub/nitro-h3" }),
          expect.objectContaining({ name: "vite-hub/nitro-cache-bypass" }),
        ],
      },
      sandbox: true,
      virtual: { "#vitehub/kv/config": "export const hosting = undefined\nexport const kv = false\nexport const loadDatabases = undefined\nexport default { hosting, kv }\n" },
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

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(mocks.useEnvPlugin).toHaveBeenCalledWith(existingEnvPlugin)
    // SAFETY: Nuxt stores Vite plugin options as the nested array shape flattened here.
    expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toContain(existingEnvPlugin)
  })

  it("preserves promised Vite plugins during module setup", async () => {
    const promisedPlugin = Promise.resolve({ name: "promised-vite-plugin" })
    const nestedPromisedPlugin = Promise.resolve({ name: "nested-promised-vite-plugin" })
    const { nuxt } = createNuxt(false, [promisedPlugin, [nestedPromisedPlugin]])

    await viteHubNuxtModule({ host: "node" }, nuxt)

    // SAFETY: Nuxt plugin setup always assigns an array of Vite plugin options.
    const configuredPlugins = nuxt.options.vite.plugins as unknown[]
    expect(configuredPlugins).toContain(promisedPlugin)
    expect(configuredPlugins.flat(Infinity)).toContain(nestedPromisedPlugin)
  })

  it("replays configured Nuxt Vite options into Nitro hooks", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: `${tmp}/vitehub-nuxt/custom-vite-root`,
      workspace: false,
    })

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
    const nitroConfig = {
      replace: {
        __VITEHUB_EXISTING_REPLACEMENT__: "existing",
      },
    }
    await runNitroConfigHook(nitroConfig)

    expect(mocks.agentHook).toHaveBeenCalledWith(
      expect.objectContaining({
        [VITEHUB_PROJECT_ROOT]: `${tmp}/vitehub-nuxt`,
        root: `${tmp}/vitehub-nuxt/custom-vite-root`,
        workspace: false,
      }),
      expect.anything(),
    )
    expect(nitroConfig.replace).toEqual({
      __VITEHUB_AGENT_APP_ROOT__: JSON.stringify(`${tmp}/vitehub-nuxt/custom-vite-root`),
      __VITEHUB_EXISTING_REPLACEMENT__: "existing",
    })
  })

  it("removes Sandbox Console metadata when Nuxt replay disables Sandbox", async () => {
    const development = createNuxt(true, [{
      name: "vite-hub/sandbox-replay",
      config: () => resolvedFeatures({ sandboxTask: false }),
    }])

    await viteHubNuxtModule({ console: { auth: false }, host: "cloudflare", sandboxTask: true }, development.nuxt)
    const nitroConfig = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(nitroConfig)

    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).not.toContain(`"sandbox-tasks"`)
    expect(generated).not.toContain(`"section":"sandbox-tasks"`)
  })

  it("keeps Sandbox Console metadata disabled when replay runs on an unsupported preset", async () => {
    const development = createNuxt(true)

    await viteHubNuxtModule({ console: { auth: false }, host: "node", sandboxTask: true }, development.nuxt)
    const nitroConfig = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(nitroConfig)

    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).not.toContain(`"sandbox-tasks"`)
    expect(generated).not.toContain(`"section":"sandbox-tasks"`)
  })

  it("removes Blob Console metadata when Nuxt replay disables Blob", async () => {
    const development = createNuxt(true, [{
      name: "vite-hub/blob-replay",
      config: () => resolvedFeatures({ blob: false }),
    }])

    await viteHubNuxtModule({ blob: { driver: "fs" }, console: { auth: false }, host: "node" }, development.nuxt)
    const nitroConfig = nitroOptions(development.nuxt)
    await development.runNitroConfigHook(nitroConfig)

    expect(nitroHandlerRoutes(nitroConfig)).not.toContain("/_vitehub/api/blob")
    const generated = await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")
    expect(generated).not.toContain(`"blob"`)
    expect(generated).not.toContain("installConsoleBlob")
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

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
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

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(nuxt.options).toMatchObject({
      nitro: {
        typescript: {
          tsConfig: {
            include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
          },
        },
      },
      typescript: {
        sharedTsConfig: {
          include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
        },
        tsConfig: {
          include: ["../.vitehub/types.d.ts", expect.stringContaining("cloudflare-types.d.ts")],
        },
      },
    })
  })

  it("adds no Cloudflare types when the app does not install @cloudflare/workers-types", async () => {
    const installed = vi.mocked(isPackageInstalled).getMockImplementation()!
    vi.mocked(isPackageInstalled).mockImplementation(name => name !== "@cloudflare/workers-types" && installed(name))
    try {
      const { nuxt } = createNuxt()

      await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

      const typescript = { tsConfig: { include: ["../.vitehub/types.d.ts"] } }
      expect(nuxt.options).toMatchObject({ nitro: { typescript }, typescript: { ...typescript, sharedTsConfig: typescript.tsConfig } })
    }
    finally {
      vi.mocked(isPackageInstalled).mockImplementation(installed)
    }
  })

  it.each([
    ["module flag", true, true],
    ["module options", { namePrefix: "app-" }, true],
    ["disabled module", false, false],
    ["unconfigured Queue", undefined, false],
  ] as const)("includes Queue types in Nuxt and Nitro for %s", async (_name, queue, enabled) => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ host: "cloudflare", queue }, nuxt)

    const typescript = {
      tsConfig: {
        include: [
          "../.vitehub/types.d.ts",
          ...(enabled ? ["../.vitehub/queue.d.ts"] : []),
          expect.stringContaining("cloudflare-types.d.ts"),
        ],
      },
    }
    expect(nuxt.options).toMatchObject({ nitro: { typescript }, typescript })
  })

  it("exposes materialized Email templates to Nuxt and Nitro on Vercel", async () => {
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: vi.fn() },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ email: true, host: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    const emailTemplates = `${tmp}/vitehub-nuxt/.vitehub/email/templates`
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
      "monthly-recap": `${tmp}/vitehub-nuxt/.vitehub/email/templates/monthly-recap.mjs`,
      "monthly-recap/detail": `${tmp}/vitehub-nuxt/.vitehub/email/templates/monthly-recap%2Fdetail.mjs`,
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ email: true, host: "cloudflare" }, nuxt)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
    })
    const emailTemplates = `${tmp}/vitehub-nuxt/.vitehub/email/templates`
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
      monthly: `${tmp}/vitehub-nuxt/.vitehub/email/templates/monthly.mjs`,
    })
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes },
        name: "@vite-hub/email/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ email: true, host: "vercel" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(nuxt.options.alias).not.toHaveProperty("#vitehub/emails/monthly")
    // SAFETY: The email integration installs Rollup plugin objects into this owned namespace.
    const rollupConfig = nitroConfig.rollupConfig as {
      plugins: Array<{ name: string; resolveId: (id: string) => string | undefined }>
    }
    const resolver = rollupConfig.plugins.find(plugin => plugin.name === "vite-hub/nuxt-email-templates")
    expect(resolver?.resolveId("#vitehub/emails/monthly/detail")).toBe(
      `${tmp}/vitehub-nuxt/.vitehub/email/templates/monthly%2Fdetail.mjs`,
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

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
    })
    const emailTemplates = `${tmp}/vitehub-nuxt/.vitehub/email/templates`
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

    await viteHubNuxtModule({ email: { driver: "resend" }, host: "node" }, nuxt)
    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)

    expect(prepareTypes).toHaveBeenCalledWith({
      materialize: true,
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
    })
    const emailTemplates = `${tmp}/vitehub-nuxt/.vitehub/email/templates`
    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
    // SAFETY: The Nitro hook initializes aliases as a string map.
    expect((nitroConfig.alias as Record<string, string>)["#vitehub/emails"]).toBe(emailTemplates)
  })

  it("includes generated types from a configured Env project root", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: { projectRoot: "apps/api" }, host: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    const tsConfig = {
      exclude: ["../apps/api/.vitehub/data/**/*.d.ts"],
      include: ["../.vitehub/types.d.ts", "../apps/api/.vitehub/**/*.d.ts"],
    }
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      sharedTsConfig: tsConfig,
      tsConfig,
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
        host: "node",
      } as never,
      nuxt,
    )

    expect(mocks.vitehub).toHaveBeenCalledWith({
      env: { projectRoot: "apps/api", server: { githubToken } },
      host: "node",
    })
    expect(nuxt.options.vite).not.toHaveProperty("env")
    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": `${tmp}/vitehub-nuxt/apps/api/.vitehub/env/server.mjs`,
    })

    const nitroConfig = { alias: { "#custom": "./custom.mjs" } }
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.alias).toMatchObject({
      "#vitehub/env/server": `${tmp}/vitehub-nuxt/apps/api/.vitehub/env/server.mjs`,
      "#custom": "./custom.mjs",
    })
  })

  it("refreshes Console Env inventory after Nuxt Vite config replay", async () => {
    // SAFETY: Env exports the standard Vite plugin hooks; the owner and framework use separate Vite type instances.
    const envPlugin = hubEnv() as unknown as Plugin
    const contribution: Plugin = {
      name: "vite-hub/env-inventory-contribution",
      // A ViteHub feature declares Server Env from a config hook, as Agent Channels do.
      config: () => ({ root: `${tmp}/vitehub-nuxt`, [VITEHUB_ENV_SERVER]: { replayedToken: env({ secret: true }) } }) as UserConfig,
    }
    const { nuxt, runNitroConfigHook } = createNuxt(true, [envPlugin, contribution])
    await viteHubNuxtModule({ console: { auth: false }, host: "node" }, nuxt)
    const descriptionPath = `${tmp}/vitehub-nuxt/.vitehub/env/description.mjs`
    expect(await readFile(descriptionPath, "utf8")).not.toContain("replayedToken")
    await runNitroConfigHook(nitroOptions(nuxt))
    const description = await readFile(descriptionPath, "utf8")
    expect(description).toContain("env.server.replayedToken")
    expect(description).not.toContain("import ")
    expect(await readFile(`${tmp}/vitehub-nuxt/.vitehub/nitro/console/plugin.mjs`, "utf8")).toContain("#vitehub/env/description")
  })

  it("prepares Env types before collecting generated declarations", async () => {
    const steps: string[] = []
    const prepareEnvTypes = vi.fn(async () => {
      steps.push("env")
    })
    const prepareTypes = vi.fn(async () => {
      steps.push("types")
    })
    const githubToken = { source: "GITHUB_TOKEN" }
    const resolveDeclarations = vi.fn(() => ({ server: { githubToken } }))
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareTypes: prepareEnvTypes, resolveDeclarations, resolveProjectRoot: (root: string) => root },
        name: "@vite-hub/env/vite",
      },
      {
        api: { prepareTypes },
        name: "vite-hub/types",
      },
    ])
    const { nuxt } = createNuxt()

    // SAFETY: The test exercises runtime support for an Env option not present in the Nuxt schema yet.
    await viteHubNuxtModule({ env: { server: { githubToken } }, host: "node" } as never, nuxt)

    expect(resolveDeclarations).toHaveBeenCalledWith(nuxt.options.vite)
    expect(prepareEnvTypes).toHaveBeenCalledWith({ server: { githubToken } }, `${tmp}/vitehub-nuxt`)
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
    await viteHubNuxtModule({ host: "node" } as never, nuxt)

    expect(cleanupEmailTypes).toHaveBeenCalledWith(`${tmp}/vitehub-nuxt`)
    expect(steps).toEqual(["email", "types"])
  })

  it("registers generated Collection handlers without replacing unrelated handlers", async () => {
    const generated = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/meals.mjs`,
      method: "get" as const,
      route: "/api/meals",
    }
    const prepareSources = vi.fn(async () => [generated])
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareSources },
        name: "@vite-hub/source/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ host: "node" }, nuxt)
    const existing = { handler: "server/health.ts", method: "get", route: "/api/health" }
    const nitroConfig = { handlers: [existing] }
    await runNitroConfigHook(nitroConfig)

    expect(prepareSources).toHaveBeenCalledWith({
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
    })
    // Generated routes load on their first request; unrelated handlers stay as they are.
    expect(nitroConfig.handlers).toEqual([existing, { ...generated, lazy: true }])
  })

  it("restarts Nuxt with the current generated Source handlers", async () => {
    const first = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/meals.mjs`,
      method: "get" as const,
      route: "/api/meals",
    }
    const second = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/drinks.mjs`,
      method: "get" as const,
      route: "/api/drinks",
    }
    const third = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/snacks.mjs`,
      method: "get" as const,
      route: "/api/snacks",
    }
    let listener: ((handlers: Array<{ handler: string; method: "get"; route: string }>) => Promise<void> | void) | undefined
    const removeListener = vi.fn()
    const onGeneratedHandlersChanged = vi.fn((value: NonNullable<typeof listener>) => {
      listener = value
      return removeListener
    })
    const prepareTypes = vi.fn(async () => {})
    mocks.vitehub.mockReturnValue([
      {
        api: {
          onGeneratedHandlersChanged,
          prepareSources: vi.fn(async () => [first]),
        },
        name: "@vite-hub/source/vite",
      },
      {
        api: { prepareTypes, setPrepareSources: vi.fn() },
        name: "vite-hub/types",
      },
    ])
    const { closeHooks, nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ host: "node" }, nuxt)
    expect(onGeneratedHandlersChanged).toHaveBeenCalledWith(expect.any(Function), {
      handlesHostRestart: true,
      projectRoot: `${tmp}/vitehub-nuxt`,
    })
    nuxt.callHook.mockRejectedValueOnce(new Error("restart failed"))
    await expect(listener?.([second])).rejects.toThrow("restart failed")
    const failedNitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(failedNitroConfig)
    expect(failedNitroConfig.handlers).toEqual([{ ...first, lazy: true }])

    await listener?.([second])
    expect(nuxt.callHook).toHaveBeenCalledWith("restart")
    expect(prepareTypes).toHaveBeenLastCalledWith({ projectRoot: `${tmp}/vitehub-nuxt` })
    expect(prepareTypes.mock.invocationCallOrder.at(-1)).toBeLessThan(nuxt.callHook.mock.invocationCallOrder.at(-1)!)

    const nitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.handlers).toEqual([{ ...second, lazy: true }])

    let rejectOlderRestart: ((reason?: unknown) => void) | undefined
    const olderRestart = new Promise<void>((_resolve, reject) => {
      rejectOlderRestart = reject
    })
    nuxt.callHook.mockImplementationOnce(() => olderRestart)
    const olderUpdate = listener?.([first])
    const newerUpdate = listener?.([third])
    const olderFailure = expect(olderUpdate).rejects.toThrow("restart failed")
    rejectOlderRestart?.(new Error("restart failed"))
    await olderFailure
    await newerUpdate

    const concurrentNitroConfig: Record<string, unknown> = {}
    await runNitroConfigHook(concurrentNitroConfig)
    expect(concurrentNitroConfig.handlers).toEqual([{ ...third, lazy: true }])

    let finishPendingPreparation: (() => void) | undefined
    prepareTypes.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPendingPreparation = resolve
    }))
    const callsBeforeClose = nuxt.callHook.mock.calls.length
    const preparationsBeforeClose = prepareTypes.mock.calls.length
    const pendingUpdate = listener?.([first])
    const queuedUpdate = listener?.([second])
    await vi.waitFor(() => expect(prepareTypes).toHaveBeenCalledTimes(preparationsBeforeClose + 1))
    closeHooks.forEach(hook => hook())
    finishPendingPreparation?.()
    await Promise.all([pendingUpdate, queuedUpdate])
    expect(nuxt.callHook).toHaveBeenCalledTimes(callsBeforeClose)
    expect(removeListener).toHaveBeenCalledOnce()
  })

  it("binds type preparation to the selected Source plugin", async () => {
    const defaultPrepareSources = vi.fn(async () => [])
    const selectedPrepareSources = vi.fn(async () => [])
    const setPrepareSources = vi.fn()
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareSources: defaultPrepareSources },
        name: "@vite-hub/source/vite",
      },
      {
        api: { prepareTypes: vi.fn(), setPrepareSources },
        name: "vite-hub/types",
      },
    ])
    const selectedSource = {
      api: { prepareSources: selectedPrepareSources },
      name: "@vite-hub/source/vite",
    }
    const { nuxt } = createNuxt(false, [selectedSource])

    await viteHubNuxtModule({ host: "node" }, nuxt)

    expect(selectedPrepareSources).toHaveBeenCalledWith({
      projectRoot: `${tmp}/vitehub-nuxt`,
      serverDirs: [`${tmp}/vitehub-nuxt/custom-server`],
    })
    expect(defaultPrepareSources).not.toHaveBeenCalled()
    expect(setPrepareSources).toHaveBeenCalledWith(selectedPrepareSources)
    // SAFETY: The Nuxt replay path has normalized this fixture's plugin list before this assertion.
    const configuredPlugins = nuxt.options.vite.plugins as Plugin[]
    expect(configuredPlugins.indexOf(selectedSource)).toBeLessThan(
      configuredPlugins.findIndex(plugin => plugin.name === "vite-hub/types"),
    )
  })

  it("rejects handlers that bypass a generated Collection route", async () => {
    const generated = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/meals.mjs`,
      method: "get" as const,
      route: "/api/meals",
    }
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareSources: vi.fn(async () => [generated]) },
        name: "@vite-hub/source/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ host: "node" }, nuxt)

    await expect(
      runNitroConfigHook({
        handlers: [{ handler: "server/api/meals.get.ts", method: "get", route: "/api/meals" }],
      }),
    ).rejects.toThrow('Generated Collection route "/api/meals" conflicts with an existing GET handler')
  })

  it("rejects scanned server routes that bypass a generated Collection route", async () => {
    const generated = {
      handler: `${tmp}/vitehub-nuxt/.vitehub/source/routes/meals.mjs`,
      method: "get" as const,
      route: "/api/meals",
    }
    mocks.vitehub.mockReturnValue([
      {
        api: { prepareSources: vi.fn(async () => [generated]) },
        name: "@vite-hub/source/vite",
      },
    ])
    const { nuxt, runNitroConfigHook } = createNuxt()

    await viteHubNuxtModule({ host: "node" }, nuxt)
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

  it("derives Env aliases from an existing Env Vite plugin", async () => {
    const envPlugin = {
      name: "@vite-hub/env/vite",
      api: {
        resolveProjectRoot: (root: string) => resolve(root, "packages/config"),
      },
    }
    const { nuxt } = createNuxt(false, [envPlugin])

    await viteHubNuxtModule({ host: "node" }, nuxt)

    expect(nuxt.options.alias).toMatchObject({
      "#vitehub/env/server": `${tmp}/vitehub-nuxt/packages/config/.vitehub/env/server.mjs`,
    })
  })

  it("keeps Env runtime aliases disabled", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ env: false, host: "node" }, nuxt)

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
        host: "node",
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

  it("resolves generated type roots from the Nuxt project root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })
    await mkdir(`${tmp}/vitehub-nuxt/app`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/app/package.json`, `${JSON.stringify({ name: "vitehub-app" })}\n`)

    await viteHubNuxtModule({ env: { projectRoot: "packages/config" }, host: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../app/packages/config/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../app/packages/config/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("resolves Database generated types from the Nuxt root", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options.vite, { root: "app" })
    await mkdir(`${tmp}/vitehub-nuxt/app`, { recursive: true })
    await writeFile(`${tmp}/vitehub-nuxt/app/package.json`, `${JSON.stringify({ name: "vitehub-app" })}\n`)

    await viteHubNuxtModule({ database: { projectRoot: "packages/db" }, host: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    expect((nuxt.options as typeof nuxt.options & { typescript: Record<string, unknown> }).typescript).toMatchObject({
      tsConfig: {
        exclude: ["../packages/db/.vitehub/data/**/*.d.ts"],
        include: ["../.vitehub/types.d.ts", "../packages/db/.vitehub/**/*.d.ts"],
      },
    })
  })

  it("ignores a Database project root in a top-level Nuxt `database` key", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      database: { projectRoot: "packages/db" },
    })

    await viteHubNuxtModule({ database: true, host: "node" }, nuxt)

    // SAFETY: The module initializes Nuxt's TypeScript options before setup completes.
    const { tsConfig } = (nuxt.options as typeof nuxt.options & { typescript: { tsConfig: { exclude?: string[], include?: string[] } } }).typescript
    expect([...tsConfig.exclude ?? [], ...tsConfig.include ?? []].join("\n")).not.toContain("packages/db")
  })

  it("installs the Database Nuxt runtime alias through the framework module", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options.vite, {
      root: `${tmp}/vitehub-nuxt/custom-vite-root`,
    })

    await viteHubNuxtModule(
      { database: { databaseId: "content-id", databaseName: "content" }, host: "cloudflare" },
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
        "@vite-hub/database/runtime/registry": `${tmp}/vitehub-nuxt/.vitehub/database/cloudflare-runtime.mjs`,
        "@vite-hub/database/runtime/state": databaseRuntimeState,
      },
    })
  })

  it("keeps the Database Nitro runtime alias out of development", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt(true)

    await viteHubNuxtModule({ database: true, host: "cloudflare" }, nuxt)
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
      { database: { databaseId: "content-id", databaseName: "content" }, host: "cloudflare" },
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

  it("installs the Auth Vue and server runtime integration through module options", async () => {
    const { nitroConfigHooks, nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, host: "cloudflare" }, nuxt)

    // SAFETY: The Auth integration initializes imports and Nitro runtime configuration.
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string; name: string }> }
      nitro: { alias: Record<string, string>; plugins: string[] }
    }
    expect(options.imports.imports).toEqual([
      { from: "vite-hub/source/client", name: "useCollection" },
      { from: "vite-hub/decisions/vue", name: "useChoices" },
      { from: "vite-hub/auth/vue", name: "useAbility" },
      { from: "vite-hub/auth/vue", name: "useAuthClient" },
      { from: "vite-hub/auth/vue", name: "useSession" },
      { from: "vite-hub/auth/vue", name: "useUserSession" },
    ])
    expect(options.nitro.alias["#vitehub/env/server"]).toBe(`${tmp}/vitehub-nuxt/.vitehub/env/server.mjs`)
    expect(options.nitro.alias["#vitehub/env/description"]).toBe(`${tmp}/vitehub-nuxt/.vitehub/env/description.mjs`)
    expect(options.nitro.plugins).toHaveLength(1)
    expect(options.nitro.plugins[0]).toMatch(/\/runtime\/nuxt\.js$/)
    expect(nitroConfigHooks).toHaveLength(1)
  })

  it("auto-imports the server helpers of every enabled feature after Nuxt's own entries", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    await viteHubNuxtModule({ blob: true, database: true, kv: true, host: "node", queue: true, rateLimit: true, schedule: true }, nuxt)

    const config: Record<string, unknown> = { imports: { autoImport: true, imports: [{ from: "#app", name: "useAppConfig" }] } }
    await runNitroConfigHook(config)

    const names = (from: string, ...list: string[]) => list.map(name => ({ from, name, priority: -1 }))
    expect(config).toHaveProperty("imports.imports", [
      { from: "#app", name: "useAppConfig" },
      ...names("vite-hub/blob", "blob"),
      ...names("vite-hub/database", "db", "schema", "useDatabase"),
      ...names("vite-hub/env", "useServerEnv"),
      ...names("vite-hub/kv", "kv"),
      ...names("vite-hub/queue", "defineQueue", "deferQueue", "useQueue", "sendQueue"),
      ...names("vite-hub/rate-limit", "checkRateLimit", "peekRateLimit", "requireRateLimit", "resetRateLimit"),
      ...names("vite-hub/schedule", "cancelSchedule", "getSchedule", "listSchedules", "startSchedule"),
    ])
  })

  it("auto-imports only the server helpers of enabled features", async () => {
    const kvOnly = createNuxt()
    await viteHubNuxtModule({ env: false, kv: true, host: "node" }, kvOnly.nuxt)
    const kvConfig: Record<string, unknown> = { imports: { imports: [] } }
    await kvOnly.runNitroConfigHook(kvConfig)
    expect(kvConfig).toHaveProperty("imports.imports", [{ from: "vite-hub/kv", name: "kv", priority: -1 }])

    // Env is on unless the app sets `env: false`.
    const defaults = createNuxt()
    await viteHubNuxtModule({ host: "node" }, defaults.nuxt)
    const defaultConfig: Record<string, unknown> = { imports: { imports: [] } }
    await defaults.runNitroConfigHook(defaultConfig)
    expect(defaultConfig).toHaveProperty("imports.imports", [{ from: "vite-hub/env", name: "useServerEnv", priority: -1 }])

    // A host without a Queue service does not install the Queue package, so it gets no Queue helpers.
    const netlify = createNuxt()
    await viteHubNuxtModule({ env: false, host: "netlify", queue: true }, netlify.nuxt)
    const netlifyConfig: Record<string, unknown> = { imports: { imports: [] } }
    await netlify.runNitroConfigHook(netlifyConfig)
    expect(netlifyConfig).toHaveProperty("imports.imports", [])
  })

  it.each([
    { host: "cloudflare", agent: true, workflow: undefined, enabled: true },
    { host: "node", agent: true, workflow: undefined, enabled: true },
    { host: "vercel", agent: true, workflow: undefined, enabled: true },
    { host: "netlify", agent: true, workflow: undefined, enabled: false },
    { host: "cloudflare", agent: true, workflow: false, enabled: false },
    { host: "cloudflare", agent: false, workflow: undefined, enabled: false },
    { host: "cloudflare", agent: false, workflow: true, enabled: true },
  ] as const)("selects server imports for effective Workflow enablement: %j", async ({ host, agent, workflow, enabled }) => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    // Read Agent from Nuxt options too, as applications configured through vitehub() do.
    Object.assign(nuxt.options, { vitehub: { agent } })
    await viteHubNuxtModule({ env: false, host, workflow }, nuxt)

    const config: { imports: { imports: { from: string, name: string }[] } } = { imports: { imports: [] } }
    await runNitroConfigHook(config)
    expect(config.imports.imports.filter(entry => entry.from === "vite-hub/workflow").map(entry => entry.name)).toEqual(
      enabled ? ["cancelWorkflow", "deferWorkflow", "getWorkflowRun", "resumeWorkflow", "startWorkflow"] : [],
    )
  })

  it.each([false, true])("auto-imports I18n server helpers from inline or Nuxt module options: %s", async (inline) => {
    const root = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-i18n-"))
    try {
      // Nuxt 5 uses its Nitro 3 server builder; the default fixture has no installed Nuxt host.
      for (const [name, manifest] of [
        ["nuxt", { name: "nuxt", dependencies: { "@nuxt/nitro-server": "5.0.0" } }],
        ["@nuxt/nitro-server", { name: "@nuxt/nitro-server", dependencies: { nitro: "3.0.261102-rc" } }],
        ["nitro", { name: "nitro", version: "3.0.261102-rc" }],
      ] as const) {
        const directory = resolve(root, "node_modules", name)
        await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, "package.json"), JSON.stringify(manifest))
      }
      const { nuxt, runNitroConfigHook } = createNuxt()
      nuxt.options.rootDir = root
      nuxt.options.buildDir = resolve(root, ".nuxt")
      nuxt.options.serverDir = resolve(root, "server")
      const i18n = { locales: ["en", "es"], workspace: "translations" }
      if (!inline) Object.assign(nuxt.options, { vitehub: { i18n } })
      await viteHubNuxtModule({ env: false, host: "node", ...inline ? { i18n } : {} }, nuxt)

      const config: Record<string, unknown> = { imports: { imports: [] } }
      await runNitroConfigHook(config)
      expect(config).toHaveProperty("imports.imports", [
        { from: "vite-hub/i18n/server", name: "getRequestI18n", priority: -1 },
        { from: "vite-hub/i18n/server", name: "useTranslations", priority: -1 },
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("merges inline module options into the vitehub key per leaf", async () => {
    const { nuxt } = createNuxt()
    // A layer or the app sets the vitehub key, and a modules tuple sets inline options.
    Object.assign(nuxt.options, {
      vitehub: {
        kv: { driver: "redis", url: "env:REDIS_URL" },
        queue: { namePrefix: "app" },
        cache: true,
        realtime: true,
        i18n: { locales: ["en", "es"], workspace: "translations" },
      },
    })
    await viteHubNuxtModule({
      env: false,
      host: "node",
      kv: true,
      queue: false,
      cache: { driver: "fs-lite", base: "cache" },
      i18n: { locales: ["en", "fr"] },
    }, nuxt)

    expect(mocks.vitehub.mock.calls.at(-1)?.[0]).toMatchObject({
      kv: { driver: "redis", url: "env:REDIS_URL" },
      queue: false,
      cache: { driver: "fs-lite", base: "cache" },
      realtime: true,
      i18n: { locales: ["en", "fr"], workspace: "translations" },
    })
  })

  it("lets an inline `true` replace a nested option that is an object", async () => {
    const { nuxt } = createNuxt()
    const declaration = { mode: "build", default: false }
    Object.assign(nuxt.options, { vitehub: { env: { define: { FEATURE_ENABLED: declaration }, server: { FLAG: declaration } } } })
    await viteHubNuxtModule({ host: "node", env: { define: { FEATURE_ENABLED: true }, server: { FLAG: true } } } as Parameters<typeof viteHubNuxtModule>[0], nuxt)

    expect(mocks.vitehub.mock.calls.at(-1)?.[0]).toMatchObject({ env: { define: { FEATURE_ENABLED: true }, server: { FLAG: true } } })
  })

  it("reads feature switches from the Nuxt module options", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    Object.assign(nuxt.options, { vitehub: { kv: {}, rateLimit: {} } })
    await viteHubNuxtModule({ env: false, host: "node" }, nuxt)

    const config: Record<string, unknown> = { imports: { imports: [] } }
    await runNitroConfigHook(config)
    expect(config).toHaveProperty("imports.imports", expect.arrayContaining([
      { from: "vite-hub/kv", name: "kv", priority: -1 },
      { from: "vite-hub/rate-limit", name: "requireRateLimit", priority: -1 },
    ]))
  })

  it("adds no server auto-imports when the app turns Nuxt auto-imports off", async () => {
    // `imports: { autoImport: false }` in nuxt.config.ts reaches Nitro as `imports.autoImport: false`.
    const autoImportOff = createNuxt()
    await viteHubNuxtModule({ kv: true, host: "node", queue: true }, autoImportOff.nuxt)
    const autoImportOffConfig: Record<string, unknown> = { imports: { autoImport: false, imports: [] } }
    await autoImportOff.runNitroConfigHook(autoImportOffConfig)
    expect(autoImportOffConfig).toHaveProperty("imports.imports", [])

    // `nitro: { imports: false }` reaches Nitro as `imports: false`.
    const nitroImportsOff = createNuxt()
    await viteHubNuxtModule({ blob: true, kv: true, host: "node" }, nitroImportsOff.nuxt)
    const nitroImportsOffConfig: Record<string, unknown> = { imports: false }
    await nitroImportsOff.runNitroConfigHook(nitroImportsOffConfig)
    expect(nitroImportsOffConfig.imports).toBe(false)

    const unset = createNuxt()
    await viteHubNuxtModule({ kv: true, host: "node" }, unset.nuxt)
    const unsetConfig: Record<string, unknown> = {}
    await unset.runNitroConfigHook(unsetConfig)
    expect(unsetConfig).not.toHaveProperty("imports")
  })

  it("keeps a server auto-import name that another source already configures", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    await viteHubNuxtModule({ env: false, kv: true, host: "node", queue: true }, nuxt)

    const config: Record<string, unknown> = {
      imports: {
        imports: [{ from: "~/server/utils/kv", name: "kv" }],
        presets: [{ from: "custom-queue", imports: ["defineQueue", { as: "sendQueue", name: "enqueue" }] }],
      },
    }
    await runNitroConfigHook(config)

    expect(config).toHaveProperty("imports.imports", [
      { from: "~/server/utils/kv", name: "kv" },
      { from: "vite-hub/queue", name: "deferQueue", priority: -1 },
      { from: "vite-hub/queue", name: "useQueue", priority: -1 },
    ])
  })

  it("registers each server auto-import once when Nuxt replays the Nitro config", async () => {
    const { nuxt, runNitroConfigHook } = createNuxt()
    await viteHubNuxtModule({ env: false, kv: true, host: "node" }, nuxt)

    const config: Record<string, unknown> = { imports: { imports: [] } }
    await runNitroConfigHook(config)
    await runNitroConfigHook(config)
    expect(config).toHaveProperty("imports.imports", [{ from: "vite-hub/kv", name: "kv", priority: -1 }])
  })

  it("auto-imports Agent Vue clients only when Agent Definitions are enabled", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ agent: true, host: "cloudflare" }, nuxt)

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
      { from: "vite-hub/decisions/vue", name: "useChoices" },
    ])
  })

  it("prebundles the Agent Vue client and preserves configured optimizer entries", async () => {
    const enabled = createNuxt(true)
    enabled.nuxt.options.vite.optimizeDeps = { include: ["consumer-client"] }
    await viteHubNuxtModule({ agent: true, host: "node" }, enabled.nuxt)
    expect(enabled.nuxt.options.vite.optimizeDeps.include).toEqual(["consumer-client", "vite-hub/agent/vue"])

    const existing = createNuxt(true)
    existing.nuxt.options.vite.optimizeDeps = { include: ["vite-hub/agent/vue"] }
    await viteHubNuxtModule({ agent: true, host: "node" }, existing.nuxt)
    expect(existing.nuxt.options.vite.optimizeDeps.include).toEqual(["vite-hub/agent/vue"])

    const disabled = createNuxt(true)
    disabled.nuxt.options.vite.optimizeDeps = { include: ["consumer-client"] }
    await viteHubNuxtModule({ host: "node" }, disabled.nuxt)
    expect(disabled.nuxt.options.vite.optimizeDeps.include).toEqual(["consumer-client"])
  })

  it("auto-imports the Blob upload composables only when Blob is enabled", async () => {
    const withBlob = createNuxt()
    const withoutBlob = createNuxt()

    await viteHubNuxtModule({ blob: true, host: "node" }, withBlob.nuxt)
    await viteHubNuxtModule({ host: "node" }, withoutBlob.nuxt)

    // SAFETY: The module initializes Nuxt's imports collection.
    const imports = (nuxt: typeof withBlob.nuxt) => (nuxt.options as typeof nuxt.options & { imports: { imports: Array<{ from: string, name: string }> } }).imports.imports
    expect(imports(withBlob.nuxt)).toEqual([
      { from: "vite-hub/source/client", name: "useCollection" },
      { from: "vite-hub/decisions/vue", name: "useChoices" },
      { from: "vite-hub/blob/vue", name: "useMultipartUpload" },
      { from: "vite-hub/blob/vue", name: "useUpload" },
    ])
    expect(imports(withoutBlob.nuxt)).toEqual([{ from: "vite-hub/source/client", name: "useCollection" }, { from: "vite-hub/decisions/vue", name: "useChoices" }])
  })

  it("rejects a configured Nuxt composable that would bind a different useChat", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await expect(viteHubNuxtModule({ agent: true, host: "cloudflare" }, nuxt)).rejects.toThrow(
      "Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from @ai-sdk/vue",
    )
  })

  it("checks Nuxt composable collisions against their exposed aliases", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      imports: { imports: [{ as: "useAiChat", from: "@ai-sdk/vue", name: "useChat" }] },
    })

    await viteHubNuxtModule({ agent: true, host: "cloudflare" }, nuxt)
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
    await expect(viteHubNuxtModule({ agent: true, host: "cloudflare" }, conflictingNuxt)).rejects.toThrow(
      "Cannot auto-import useChat from vite-hub/agent/vue because it is already configured from custom-chat",
    )
  })

  it("auto-imports Realtime definition and Vue helpers", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ host: "cloudflare", realtime: true }, nuxt)

    expect(nitroOptions(nuxt)).toMatchObject({
      features: { websocket: true },
      preset: "cloudflare-module",
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

    await viteHubNuxtModule({ auth: true, host: "cloudflare" }, nuxt)

    // SAFETY: Nuxt aliases are normalized to a string map by the module setup path.
    expect((nuxt.options.alias as Record<string, string>)["#vitehub/env/server"]).toBe(
      resolve(".vitehub/env/server.mjs"),
    )
  })

  it("keeps Auth composables without Env runtime wiring", async () => {
    const { nuxt } = createNuxt()

    await viteHubNuxtModule({ auth: true, env: false, host: "cloudflare" }, nuxt)

    // SAFETY: The Auth integration initializes imports and Nitro runtime configuration.
    const options = nuxt.options as typeof nuxt.options & {
      imports: { imports: Array<{ from: string; name: string }> }
      nitro: Record<string, unknown>
    }
    expect(options.imports.imports).toHaveLength(6)
    expect(options.imports.imports).toContainEqual({ from: "vite-hub/auth/vue", name: "useAbility" })
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

    await viteHubNuxtModule({ host: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    expect(nitroConfig).toMatchObject({
      modules: ["first", "second"],
    })
  })

  it.each([
    { incomingNoExternals: undefined, inPlace: false },
    { incomingNoExternals: false, inPlace: false },
    { incomingNoExternals: true, inPlace: false },
    { incomingNoExternals: ["effect"], inPlace: false },
    { incomingNoExternals: false, inPlace: true },
    { incomingNoExternals: true, inPlace: true },
  ])("keeps replayed package lists in noExternals and an explicit boolean ($incomingNoExternals, inPlace: $inPlace)", async ({ incomingNoExternals, inPlace }) => {
    const matcher = /consumer-package/
    const noExternals = ["effect", "@effect/platform-node", matcher]
    mocks.vitehub.mockReturnValue([{
      name: "vite-hub/nitro-inlining",
      config: (config: { nitro?: Record<string, unknown> }) => {
        if (inPlace) {
          config.nitro ??= {}
          config.nitro.noExternals = noExternals
          return
        }
        return { nitro: { ...config.nitro, noExternals } }
      },
    }])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig: Record<string, unknown> = incomingNoExternals === undefined ? {} : { noExternals: incomingNoExternals }

    await viteHubNuxtModule({ host: "node" }, nuxt)
    const viteHubEntries = ["vite-hub", "@vite-hub/", `${tmp}/vitehub-nuxt/.vitehub`, h3RuntimeRoot]
    // `true` bundles every package and an explicit `false` keeps only ViteHub's packages. Otherwise Nitro must bundle
    // the replayed lists and ViteHub's packages.
    const expected = incomingNoExternals === true ? true : incomingNoExternals === false ? viteHubEntries : [...noExternals, ...viteHubEntries]
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.noExternals).toEqual(expected)
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.noExternals).toEqual(expected)
    expect(noExternals).toEqual(["effect", "@effect/platform-node", matcher])
    expect(nitroConfig).not.toHaveProperty("externals")
  })

  it.each([
    { noExternals: true },
    { noExternals: false },
    { noExternals: undefined },
    { noExternals: [] },
    { noExternals: ["consumer-package"] },
  ])("adds ViteHub's packages to Nitro noExternals $noExternals", async ({ noExternals }) => {
    mocks.vitehub.mockReturnValue([])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig: Record<string, unknown> = noExternals === undefined ? {} : { noExternals }

    await viteHubNuxtModule({ host: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)

    const viteHubEntries = ["vite-hub", "@vite-hub/", `${tmp}/vitehub-nuxt/.vitehub`, h3RuntimeRoot]
    if (noExternals === true) expect(nitroConfig.noExternals).toBe(true)
    else expect(nitroConfig.noExternals).toEqual([...Array.isArray(noExternals) ? noExternals : [], ...viteHubEntries])
  })

  it.each([
    { incomingNoExternals: undefined, replayList: false },
    { incomingNoExternals: false, replayList: false },
    { incomingNoExternals: false, replayList: true },
    { incomingNoExternals: true, replayList: true },
  ])("keeps required Nitro 3 inlining with policy $incomingNoExternals (replayList: $replayList) and H3 2", async ({ incomingNoExternals, replayList }) => {
    const root = await mkdtemp(resolve(tmpdir(), "vitehub-nuxt-nitro3-externals-"))
    const writePackage = async (directory: string, manifest: object) => {
      await mkdir(directory, { recursive: true })
      await writeFile(resolve(directory, "package.json"), JSON.stringify(manifest))
    }
    try {
      const nuxtRoot = resolve(root, "node_modules/nuxt")
      const builderRoot = resolve(nuxtRoot, "node_modules/@nuxt/nitro-server")
      await writePackage(nuxtRoot, { name: "nuxt", dependencies: { "@nuxt/nitro-server": "5.0.0" } })
      await writePackage(builderRoot, { name: "@nuxt/nitro-server", dependencies: { nitro: "3.0.261102-rc" } })
      await writePackage(resolve(builderRoot, "node_modules/nitro"), { name: "nitro", version: "3.0.261102-rc" })
      mocks.vitehub.mockReturnValue(!replayList ? [] : [{
        name: "consumer-nitro-inlining",
        config: () => ({ nitro: { noExternals: ["effect", "@effect/platform-node"] } }),
      }])
      const { nuxt, runModulesDoneHook, runNitroConfigHook } = createNuxt()
      nuxt.options.rootDir = root
      nuxt.options.buildDir = resolve(root, ".nuxt")
      nuxt.options.serverDir = resolve(root, "server")
      // A module that points `h3` at nitropack's H3 1, as @nuxtjs/mcp-toolkit does.
      const h3One = resolve(root, "node_modules/nitropack/node_modules/h3")
      await writePackage(h3One, { name: "h3", version: "1.15.11" })
      await writeFile(resolve(h3One, "index.cjs"), "")
      const transpiled = /^\/app\/node_modules\/docs(?!.*node_modules)/
      const nitroConfig: Record<string, unknown> = { noExternals: incomingNoExternals ?? ["@nuxt/", transpiled], alias: { h3: resolve(h3One, "index.cjs"), kept: "/app/kept.ts" } }

      await viteHubNuxtModule({ console: false, host: "node" }, nuxt)
      runModulesDoneHook()
      await runNitroConfigHook(nitroConfig)

      const owned = ["vite-hub", "@vite-hub/", resolve(root, ".vitehub"), h3RuntimeRoot]
      const inlined = incomingNoExternals === undefined ? ["@nuxt/", transpiled] : []
      const expectedNoExternals = incomingNoExternals === true
        ? true
        : [...inlined, ...owned]
      expect(nitroConfig.noExternals).toEqual(expectedNoExternals)
      await runNitroConfigHook(nitroConfig)
      expect(nitroConfig.noExternals).toEqual(expectedNoExternals)
      expect(nitroConfig).not.toHaveProperty("externals")
      expect(nitroConfig.alias).not.toHaveProperty("h3")
      expect(nitroConfig.alias).toHaveProperty("kept", "/app/kept.ts")
      nitroConfig.noExternals = true
      await runNitroConfigHook(nitroConfig)
      expect(nitroConfig.noExternals).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("resolves generated Workspace plugins from the project rather than server directory", async () => {
    const fixture = createNuxt(false)
    await viteHubNuxtModule({ host: "node" }, fixture.nuxt)
    const config = { plugins: [".vitehub/nitro/workspace/plugin.ts", "/consumer/plugin.ts", "package-plugin"] }
    await fixture.runNitroConfigHook(config)
    expect(config.plugins).toEqual([`${tmp}/vitehub-nuxt/.vitehub/nitro/workspace/plugin.ts`, "/consumer/plugin.ts", "package-plugin"])
  })

  it("keeps H3 2 for ViteHub modules while leaving application H3 imports to Nuxt", async () => {
    const fixture = createNuxt(false)
    await viteHubNuxtModule({ host: "node" }, fixture.nuxt)
    const config: Record<string, unknown> = {}
    await fixture.runNitroConfigHook(config)
    const plugins = (config.rollupConfig as { plugins: Array<{ name: string, resolveId?: (id: string, importer: string) => string | undefined }> }).plugins
    const resolver = plugins.find(plugin => plugin.name === "vite-hub/nitro-h3")!
    for (const importer of [fileURLToPath(import.meta.resolve("@vite-hub/auth")), `${tmp}/vitehub-nuxt/.vitehub/nitro/workspace/plugin.ts`, `${tmp}/vitehub-nuxt/.nuxt/vitehub/runtime.mjs`, fileURLToPath(new URL("../src/nuxt.ts", import.meta.url))]) {
      expect(resolver.resolveId?.("h3", importer)).toBe(fileURLToPath(import.meta.resolve("h3")))
    }
    expect(resolver.resolveId?.("h3", "/app/server/api/example.ts")).toBeUndefined()
    expect(resolver.resolveId?.("other", "/app/node_modules/vite-hub/dist/nuxt.js")).toBeUndefined()
  })

  it("leaves H3 to the host for a ViteHub Nuxt module whose handlers use the host's Nitro", async () => {
    const directory = await mkdtemp("/tmp/vitehub-h3-host-")
    try {
      const root = resolve(directory, "node_modules/@vite-hub/docs")
      const importer = resolve(root, "dist/runtime/server/page.js")
      await mkdir(dirname(importer), { recursive: true })
      // `#imports` makes Nuxt treat the handler as Nitro v2 code, and the handler must get the same `h3` as its helpers.
      await writeFile(resolve(root, "package.json"), JSON.stringify({ name: "@vite-hub/docs", version: "0.1.0", devDependencies: { h3: "2.0.0" } }))
      await writeFile(importer, "")
      const fixture = createNuxt(false)
      await viteHubNuxtModule({ host: "node" }, fixture.nuxt)
      const config: Record<string, unknown> = {}
      await fixture.runNitroConfigHook(config)
      const plugins = (config.rollupConfig as { plugins: Array<{ name: string, resolveId?: (id: string, importer: string) => string | undefined }> }).plugins
      const resolver = plugins.find(plugin => plugin.name === "vite-hub/nitro-h3")!
      expect(resolver.resolveId?.("h3", importer)).toBeUndefined()
    }
    finally { await rm(directory, { force: true, recursive: true }) }
  })

  it.each([
    ["node_modules/nitro", "nitro", "3.0.0-beta.1", true],
    ["node_modules/.pnpm/nitro@3.0.0/node_modules/nitro", "nitro", "3.0.0", true],
    ["node_modules/h3", "h3", "2.0.0", true],
    ["node_modules/.pnpm/h3@2.0.0/node_modules/h3", "h3", "2.0.0", true],
    ["node_modules/vite-hub", "vite-hub", "0.0.4", true],
    ["node_modules/@vite-hub/auth", "@vite-hub/auth", "0.0.4", true],
    ["packages/auth", "@vite-hub/auth", "0.0.4", true],
    ["vite-hub", "consumer", "1.0.0", false],
    ["@vite-hub", "consumer", "1.0.0", false],
    [".vitehub", "consumer", "1.0.0", false],
    ["vite-hub/node_modules/nitropack", "nitropack", "2.0.0", false],
    ["@vite-hub/node_modules/unrelated", "unrelated", "1.0.0", false],
    [".vitehub/node_modules/h3", "h3", "1.0.0", false],
  ] as const)("identifies the H3 owner at the package boundary %s", async (layout, name, version, owned) => {
    const directory = await mkdtemp("/tmp/vitehub-h3-owner-")
    try {
      const root = resolve(directory, layout)
      const importer = resolve(root, "dist/runtime.mjs")
      await mkdir(dirname(importer), { recursive: true })
      await writeFile(resolve(root, "package.json"), JSON.stringify({ name, version }))
      await writeFile(importer, "")
      const fixture = createNuxt(false)
      await viteHubNuxtModule({ host: "node" }, fixture.nuxt)
      const config: Record<string, unknown> = {}
      await fixture.runNitroConfigHook(config)
      const plugins = (config.rollupConfig as { plugins: Array<{ name: string, resolveId?: (id: string, importer: string) => string | undefined }> }).plugins
      const resolver = plugins.find(plugin => plugin.name === "vite-hub/nitro-h3")!
      for (const path of [importer, importer.replaceAll("/", "\\")]) {
        expect(resolver.resolveId?.("h3", path)).toBe(owned ? fileURLToPath(import.meta.resolve("h3")) : undefined)
      }
    }
    finally { await rm(directory, { force: true, recursive: true }) }
  })

  it("uses runtime bindings in Node Cloudflare development without a consumer shim", async () => {
    const fixture = createNuxt(true)
    await viteHubNuxtModule({ host: "cloudflare" }, fixture.nuxt)
    const config: Record<string, unknown> = {}
    await fixture.runNitroConfigHook(config)
    const alias = config.alias as Record<string, string>
    const shim = await import(alias["cloudflare:workers"]!)
    vi.stubGlobal("__env__", { EXAMPLE: "binding" })
    vi.stubEnv("FALLBACK", "process")
    try {
      expect(shim.env.EXAMPLE).toBe("binding")
      expect(shim.env.FALLBACK).toBe("process")
      expect(Object.hasOwn(shim.env, "EXAMPLE")).toBe(true)
      expect(Object.hasOwn(shim.env, "FALLBACK")).toBe(true)
      expect(Object.hasOwn(shim.env, "MISSING_BINDING")).toBe(false)
      expect(Object.keys(shim.env)).toContain("EXAMPLE")
      expect(Object.assign({}, shim.env)).toMatchObject({ EXAMPLE: "binding", FALLBACK: "process" })
      vi.stubGlobal("__env__", { NEXT: "next request" })
      expect(Object.hasOwn(shim.env, "EXAMPLE")).toBe(false)
      expect(Object.assign({}, shim.env)).toMatchObject({ NEXT: "next request", FALLBACK: "process" })
      vi.stubGlobal("__env__", undefined)
      expect(Object.assign({}, shim.env)).toHaveProperty("FALLBACK", "process")
      let completed = false
      await shim.waitUntil(Promise.resolve().then(() => { completed = true }))
      expect(completed).toBe(true)
    }
    finally { vi.unstubAllGlobals(); vi.unstubAllEnvs() }
    const production = createNuxt(false)
    await viteHubNuxtModule({ host: "cloudflare" }, production.nuxt)
    const productionConfig: Record<string, unknown> = {}
    await production.runNitroConfigHook(productionConfig)
    expect(productionConfig.alias).not.toHaveProperty("cloudflare:workers")
  })

  it("preserves Nitro inline-all policy", async () => {
    mocks.vitehub.mockReturnValue([])
    const { nuxt, runNitroConfigHook } = createNuxt()
    const nitroConfig = { externals: { inline: true, trace: false } }
    await viteHubNuxtModule({ host: "node" }, nuxt)
    await runNitroConfigHook(nitroConfig)
    expect(nitroConfig.externals).toEqual({ inline: true, trace: false })
  })

  it("does nothing when Nuxt has not initialized", async () => {
    await expect(viteHubNuxtModule({ host: "node" })).resolves.toBeUndefined()
    expect(mocks.vitehub).not.toHaveBeenCalled()
  })

  it("merges top-level Nuxt options with inline module options", async () => {
    const { nuxt } = createNuxt()
    Object.assign(nuxt.options, {
      vitehub: {
        agent: true,
        host: "node",
      },
    })

    await viteHubNuxtModule({ host: "cloudflare" }, nuxt)

    expect(mocks.vitehub).toHaveBeenCalledWith({
      agent: true,
      host: "cloudflare",
    })
  })

  it.each([undefined, "custom-output"])(
    "exposes Nuxt deployment inspection during CLI discovery with output %s",
    async (outputDir) => {
      const { nuxt } = createNuxt();
      nuxt.options.vitehubCliDiscovery = true;
      nuxt.options.nitro = {
        rootDir: "/tmp/nuxt-nitro-root",
        ...(outputDir ? { output: { dir: outputDir } } : {}),
      };
      await viteHubNuxtModule({ host: "cloudflare" }, nuxt);
      // SAFETY: The module installs flattened Vite plugins into this array.
      const plugins = nuxt.options.vite.plugins as unknown[]
      const entries = await collectViteHubProviderOutputEntries(plugins);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            owner: "vite-hub",
            path: `/tmp/nuxt-nitro-root/${outputDir ?? ".output"}/deployment.json`,
          }),
          expect.objectContaining({
            owner: "vite-hub",
            path: `/tmp/nuxt-nitro-root/${outputDir ?? ".output"}/server/wrangler.json`,
          }),
        ]),
      );
    },
  );

  it("exposes Nuxt module metadata for vitehub configuration", async () => {
    await expect(viteHubNuxtModule.getMeta()).resolves.toEqual({
      compatibility: { server: "nitro3" },
      configKey: "vitehub",
      name: "vite-hub/nuxt",
    })
  })

  it("serves Cloudflare assets after middleware and writes the deploy pointer beside the project config", async () => {
    mocks.vitehub.mockReturnValue([]);
    const root = await mkdtemp(resolve(tmpdir(), "vitehub-assets-"));
    try {
      for (const [name, manifest] of Object.entries({
        nuxt: { name: "nuxt", dependencies: { "@nuxt/nitro-server": "5.0.0" } },
        "@nuxt/nitro-server": { name: "@nuxt/nitro-server", dependencies: { nitro: "3.0.0" } },
        nitro: { name: "nitro", version: "3.0.0" },
      })) {
        await mkdir(resolve(root, "node_modules", name), { recursive: true });
        await writeFile(
          resolve(root, "node_modules", name, "package.json"),
          JSON.stringify(manifest),
        );
      }
      await mkdir(resolve(root, "docs"));
      await writeFile(resolve(root, "wrangler.jsonc"), '{ "name": "fixture" }');
      const fixture = createNuxt();
      Object.assign(fixture.nuxt.options, {
        rootDir: resolve(root, "docs"),
        buildDir: resolve(root, "docs/.nuxt"),
        serverDir: resolve(root, "docs/server"),
      });
      await viteHubNuxtModule({ host: "cloudflare", console: false }, fixture.nuxt);
      const callbacks = new Map<string, () => Promise<void>>();
      const instance = {
        options: {
          handlers: [{ handler: "application.mjs", route: "/**", middleware: true }],
          output: { serverDir: resolve(root, "docs/dist/server") },
        },
        hooks: {
          hook: (name: string, callback: () => Promise<void>) => {
            callbacks.set(name, callback);
          },
        },
      };
      await fixture.runNitroConfigHook(instance.options);
      for (const hook of fixture.nitroInitHooks) hook(instance);
      const handler = instance.options.handlers.at(-1)!.handler;
    expect(handler).toMatch(/cloudflare-assets\.mjs$/);
      expect(instance.options.handlers[0]?.handler).toBe("application.mjs");
      expect(await readFile(handler, "utf8")).toContain('from "nitro"');
      const bundle = await build({
        entryPoints: [handler],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { nitro: fileURLToPath(import.meta.resolve("h3")) },
      });
      const { default: serve } = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.text).toString("base64")}`
      );
      const fetch = vi.fn(async () => new Response("static page"));
      const request = new Request("https://docs.test/guide/");
      Object.assign(request, { runtime: { cloudflare: { env: { ASSETS: { fetch } } } } });
      expect(await (await serve({ req: request })).text()).toBe("static page");
      fetch.mockResolvedValueOnce(new Response("missing", { status: 404 }));
      expect(await serve({ req: request })).toBeUndefined();
      fetch.mockClear();
      expect(await serve({ req: new Request(request, { method: "POST" }) })).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      await mkdir(instance.options.output.serverDir, { recursive: true });
      await writeFile(resolve(instance.options.output.serverDir, "wrangler.json"), "{}");
      await callbacks.get("compiled")!();
      expect(
        JSON.parse(await readFile(resolve(root, ".wrangler/deploy/config.json"), "utf8")),
      ).toEqual({ configPath: "../../docs/dist/server/wrangler.json" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
})
