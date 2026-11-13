import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let projectRoot: string

const lifecycle = vi.hoisted(() => ({
  capture: vi.fn((_context: unknown, _catalog: unknown) => undefined),
  contribute: vi.fn(),
  finalize: vi.fn(async () => undefined),
  get: vi.fn(() => undefined),
  removeArtifactDir: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  resolveOutputs: vi.fn((): { cloudflare: false | object, vercel: false | object } => ({ cloudflare: false, vercel: { provider: "vercel" } })),
  retainSources: vi.fn(async () => ({ resolve: (path: string) => path })),
  useCatalog: vi.fn((_config: object) => ({})),
  writeProviderEntries: vi.fn(async () => ({})),
  writeWorkflowTypes: vi.fn(async () => undefined),
}))

vi.mock("../src/internal/registry-types.ts", () => ({
  writeWorkflowTypes: lifecycle.writeWorkflowTypes,
}))

vi.mock("@vite-hub/internal/build/bundle-options", async (importOriginal) => ({
  ...await importOriginal<typeof import("@vite-hub/internal/build/bundle-options")>(),
  encodeProviderOutputAliases: () => ({}),
}))

vi.mock("@vite-hub/internal/build/deployment-output", () => ({
  contributeProviderDeploymentOutput: lifecycle.contribute,
  createProviderDeploymentOutputGenerationState: () => ({
    capture: lifecycle.capture,
    get: lifecycle.get,
    reset: lifecycle.reset,
  }),
  finalizeProviderDeploymentOutputs: lifecycle.finalize,
  getProviderOutputCatalog: () => undefined,
  getProviderRuntimeModule: () => undefined,
  shouldSkipViteProviderBuild: () => false,
  useProviderOutputCatalog: lifecycle.useCatalog,
}))

vi.mock("@vite-hub/internal/build/provider-output-sources", () => ({
  providerOutputAliasSources: () => [],
  removeProviderOutputArtifactDir: lifecycle.removeArtifactDir,
  retainProviderOutputAliases: (aliases: Record<string, string>) => aliases,
  retainProviderOutputSources: lifecycle.retainSources,
}))

vi.mock("@vite-hub/internal/build/vite", async importOriginal => ({
  VITEHUB_NITRO_CONFIG_CONTEXT: "__vitehubNitroConfigContext",
  VITEHUB_SERVER_DIRS: "__vitehubServerDirs",
  collectViteHubProviderImportAliases: () => ({}),
  createNoExternalAddition: () => (value: unknown) => value,
  createProviderOutputEnvironmentOwner: (await importOriginal<typeof import("@vite-hub/internal/build/vite")>()).createProviderOutputEnvironmentOwner,
  isServerEnvironment: (name: string, config: { consumer?: string }) => name === "ssr" || config.consumer === "server",
  resolveNitroVercelFunctionName: () => undefined,
  resolveViteHubProjectRoot: (root: string) => root,
}))

vi.mock("@vite-hub/internal/hosting", () => ({
  normalizeHosting: (hosting: string | undefined) => hosting ? [hosting] : [],
}))

vi.mock("../src/config.ts", () => ({
  normalizeWorkflowOptions: (workflow: unknown) => workflow,
}))

vi.mock("../src/discovery.ts", () => ({
  discoverWorkflowDefinitions: () => [],
}))

vi.mock("../src/internal/vite-build.ts", () => ({
  createCloudflareWorkflowNitroConfig: () => ({}),
  createOptionalViteDevtoolsPlugin: () => undefined,
  createVercelWorkflowTransformPlugin: () => undefined,
  discoverWorkflowProviderSources: () => ({ agentInstructions: new Map(), paths: [] }),
  generateWorkflowProviderOutputs: () => undefined,
  hasVercelNativeWorkflowEntry: () => false,
  resolveWorkflowProviderOutputs: lifecycle.resolveOutputs,
  workflowPackageName: "@vite-hub/workflow",
  writeProviderEntries: lifecycle.writeProviderEntries,
}))

import { VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { hubWorkflow } from "../src/vite.ts"

function functionHook(hook: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof hook !== "function") throw new TypeError(`Expected ${name} hook`)
  // SAFETY: The runtime check above proves this Vite hook is callable.
  return hook as (...args: unknown[]) => unknown
}

function closeBundleHook(plugin: ReturnType<typeof hubWorkflow>): (...args: unknown[]) => unknown {
  if (!plugin.closeBundle || typeof plugin.closeBundle === "function") throw new TypeError("Expected closeBundle object hook")
  return functionHook(plugin.closeBundle.handler, "closeBundle")
}

async function createPlugin(options: { finalNitroEnvironment?: boolean; nitroPlugin?: boolean; viteHubNitroContext?: boolean } = {}) {
  const plugin = hubWorkflow()
  await functionHook(plugin.configResolved, "configResolved")({
    [VITEHUB_NITRO_CONFIG_CONTEXT]: options.viteHubNitroContext,
    ...(options.finalNitroEnvironment ? { environments: { nitro: {} } } : {}),
    build: { outDir: "dist" },
    command: "build",
    plugins: options.nitroPlugin ? [{ name: "nitro:main" }] : [],
    resolve: { alias: [] },
    root: projectRoot,
  })
  return plugin
}

async function runSuccessfulProviderLifecycle(plugin: ReturnType<typeof hubWorkflow>, environmentName: string) {
  const context = { environment: { name: environmentName } }
  functionHook(plugin.buildStart, "buildStart").call(context)
  await functionHook(plugin.buildEnd, "buildEnd").call(context)
  await closeBundleHook(plugin).call(context)
}

async function runRenderFailureLifecycle(plugin: ReturnType<typeof hubWorkflow>, environmentName: string) {
  const context = { environment: { name: environmentName } }
  functionHook(plugin.buildStart, "buildStart").call(context)
  await functionHook(plugin.buildEnd, "buildEnd").call(context)
  await functionHook(plugin.renderError, "renderError").call(context, new Error("render failed"))
}

beforeEach(async () => {
  vi.clearAllMocks()
  projectRoot = await mkdtemp(join(tmpdir(), "vitehub-workflow-lifecycle-"))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe("Workflow Provider Output lifecycle", () => {
  it("keeps same-root config clones with their own server directories and catalogs", async () => {
    const workflow = { provider: "vercel" as const }
    const plugin = hubWorkflow(workflow)
    const configs = ["first", "second"].map(name => ({
      build: { outDir: "dist" },
      command: "build",
      define: { __VITEHUB_PUBLIC_URL__: JSON.stringify("https://shared.example.com") },
      plugins: [],
      resolve: { alias: [] },
      root: projectRoot,
      __vitehubServerDirs: [join(projectRoot, name)],
    }))
    for (const config of configs) await functionHook(plugin.configResolved, "configResolved")(config)
    const catalogs = lifecycle.useCatalog.mock.results.map(result => result.value)
    const contexts = configs.map(config => {
      const clone = { ...config, build: { ...config.build } }
      Reflect.deleteProperty(clone, "__vitehubServerDirs")
      return { environment: { config: clone } }
    })
    for (const context of contexts) functionHook(plugin.buildStart, "buildStart").call(context)
    for (const [index, context] of contexts.entries()) {
      await functionHook(plugin.buildEnd, "buildEnd").call(context)
      expect(lifecycle.writeProviderEntries).toHaveBeenLastCalledWith(
        projectRoot, workflow, expect.anything(), configs[index]!.__vitehubServerDirs,
        undefined, undefined, projectRoot, expect.any(String), expect.any(Map),
      )
      expect(lifecycle.contribute).toHaveBeenLastCalledWith(catalogs[index], expect.anything(), undefined)
      await closeBundleHook(plugin).call(context)
      expect(lifecycle.finalize).toHaveBeenLastCalledWith(catalogs[index])
      const error = new Error("render failed")
      await functionHook(plugin.renderError, "renderError").call(context, error)
      expect(lifecycle.reset).toHaveBeenLastCalledWith(context, catalogs[index], error)
    }
    expect(lifecycle.useCatalog).toHaveBeenCalledTimes(2)
    expect(lifecycle.capture.mock.calls.map(call => call[1])).toEqual(catalogs)
  })

  it("fails closed when schedule runtime preparation has no resolved config", async () => {
    const plugin = hubWorkflow()
    await expect(plugin.vitehub?.workflow?.prepareScheduleRuntime?.()).rejects.toThrow("requires resolved Vite config")
  })

  it("keeps Provider Output work in the Nuxt SSR environment when Nitro builds outside Vite", async () => {
    const plugin = await createPlugin({ nitroPlugin: true, viteHubNitroContext: true })
    await runSuccessfulProviderLifecycle(plugin, "client")

    expect(lifecycle.capture).not.toHaveBeenCalled()
    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.writeProviderEntries).not.toHaveBeenCalled()
    expect(lifecycle.contribute).not.toHaveBeenCalled()
    expect(lifecycle.finalize).not.toHaveBeenCalled()

    await runSuccessfulProviderLifecycle(plugin, "ssr")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("cleans staged Provider Output after a Nuxt SSR render failure when Nitro builds outside Vite", async () => {
    await runRenderFailureLifecycle(await createPlugin({ nitroPlugin: true, viteHubNitroContext: true }), "ssr")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.reset).toHaveBeenCalledOnce()
    expect(lifecycle.removeArtifactDir).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).not.toHaveBeenCalled()
  })

  it.each(["client", "ssr"])("skips successful Nuxt 5 %s environment work", async (environmentName) => {
    await runSuccessfulProviderLifecycle(await createPlugin({ finalNitroEnvironment: true, nitroPlugin: true, viteHubNitroContext: true }), environmentName)

    expect(lifecycle.capture).not.toHaveBeenCalled()
    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.writeProviderEntries).not.toHaveBeenCalled()
    expect(lifecycle.contribute).not.toHaveBeenCalled()
    expect(lifecycle.finalize).not.toHaveBeenCalled()
  })

  it.each(["client", "ssr"])("skips Nuxt 5 %s environment render cleanup", async (environmentName) => {
    await runRenderFailureLifecycle(await createPlugin({ finalNitroEnvironment: true, nitroPlugin: true, viteHubNitroContext: true }), environmentName)

    expect(lifecycle.capture).not.toHaveBeenCalled()
    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.removeArtifactDir).not.toHaveBeenCalled()
  })

  it("runs Provider Output work in the final Nitro environment", async () => {
    await runSuccessfulProviderLifecycle(await createPlugin({ finalNitroEnvironment: true, nitroPlugin: true, viteHubNitroContext: true }), "nitro")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("cleans staged Provider Output after a final Nitro render failure", async () => {
    await runRenderFailureLifecycle(await createPlugin({ finalNitroEnvironment: true, nitroPlugin: true, viteHubNitroContext: true }), "nitro")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.reset).toHaveBeenCalledOnce()
    expect(lifecycle.removeArtifactDir).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).not.toHaveBeenCalled()
  })

  it("runs Provider Output work once when Nitro builds the client before the Nitro environment", async () => {
    const plugin = await createPlugin({ finalNitroEnvironment: true, nitroPlugin: true })
    const client = { isBuilt: false, name: "client" }
    const nitro = { isBuilt: false, name: "nitro" }
    plugin.nitro?.setup({ options: { static: false } })
    await functionHook(plugin.buildApp, "buildApp")({ environments: { client, nitro } })
    for (const environment of [client, nitro]) {
      const context = { environment }
      functionHook(plugin.buildStart, "buildStart").call(context)
      await functionHook(plugin.buildEnd, "buildEnd").call(context)
      await closeBundleHook(plugin).call(context)
      environment.isBuilt = true
    }

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.capture.mock.calls[0]?.[0]).toEqual({ environment: nitro })
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("keeps Provider Output work in plain Vite client builds", async () => {
    await runSuccessfulProviderLifecycle(await createPlugin(), "client")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("keeps Provider Output work in standalone Vite and Nitro SSR builds", async () => {
    await runSuccessfulProviderLifecycle(await createPlugin({ nitroPlugin: true }), "ssr")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("does not retain sources when the build writes no Provider Output", async () => {
    lifecycle.resolveOutputs.mockReturnValueOnce({ cloudflare: false, vercel: false })
    await runSuccessfulProviderLifecycle(await createPlugin(), "client")

    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledWith(
      projectRoot, undefined, expect.anything(), undefined,
      undefined, undefined, projectRoot, expect.any(String), expect.any(Map),
    )
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })
})
