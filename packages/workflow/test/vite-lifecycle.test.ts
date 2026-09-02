import { beforeEach, describe, expect, it, vi } from "vitest"

const lifecycle = vi.hoisted(() => ({
  capture: vi.fn(),
  contribute: vi.fn(),
  finalize: vi.fn(async () => undefined),
  get: vi.fn(() => undefined),
  removeArtifactDir: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  retainSources: vi.fn(async () => ({ resolve: (path: string) => path })),
  writeProviderEntries: vi.fn(async () => ({})),
}))

vi.mock("@vite-hub/internal/build/mode", () => ({
  getViteMode: () => undefined,
}))

vi.mock("@vite-hub/internal/build/esbuild", () => ({
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
  getProviderRuntimeModule: () => undefined,
  shouldSkipViteProviderBuild: () => false,
  useProviderOutputCatalog: () => ({}),
}))

vi.mock("@vite-hub/internal/build/provider-output-sources", () => ({
  removeProviderOutputArtifactDir: lifecycle.removeArtifactDir,
  retainProviderOutputAliases: (aliases: Record<string, string>) => aliases,
  retainProviderOutputSources: lifecycle.retainSources,
}))

vi.mock("@vite-hub/internal/build/vite", () => ({
  VITEHUB_SERVER_DIRS: "__vitehubServerDirs",
  collectViteHubProviderImportAliases: () => ({}),
  createNoExternalMerger: () => (value: unknown) => value,
  hasNitroConfigContext: (config: { plugins?: Array<{ name?: string }> }) =>
    config.plugins?.some(plugin => plugin.name === "nitro:main") ?? false,
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
  workflowPackageName: "@vite-hub/workflow",
  writeProviderEntries: lifecycle.writeProviderEntries,
}))

import { hubWorkflow } from "../src/vite.ts"

function functionHook(hook: unknown, name: string): (...args: unknown[]) => unknown {
  if (typeof hook !== "function") throw new TypeError(`Expected ${name} hook`)
  return hook as (...args: unknown[]) => unknown
}

function closeBundleHook(plugin: ReturnType<typeof hubWorkflow>): (...args: unknown[]) => unknown {
  if (!plugin.closeBundle || typeof plugin.closeBundle === "function") throw new TypeError("Expected closeBundle object hook")
  return functionHook(plugin.closeBundle.handler, "closeBundle")
}

function createPlugin(nitro: boolean) {
  const plugin = hubWorkflow()
  functionHook(plugin.configResolved, "configResolved")({
    build: { outDir: "dist" },
    command: "build",
    plugins: nitro ? [{ name: "nitro:main" }] : [],
    resolve: { alias: [] },
    root: "/project",
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Workflow Provider Output lifecycle", () => {
  it.each(["client", "ssr"])("skips successful Nuxt %s environment work", async (environmentName) => {
    await runSuccessfulProviderLifecycle(createPlugin(true), environmentName)

    expect(lifecycle.capture).not.toHaveBeenCalled()
    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.writeProviderEntries).not.toHaveBeenCalled()
    expect(lifecycle.contribute).not.toHaveBeenCalled()
    expect(lifecycle.finalize).not.toHaveBeenCalled()
  })

  it.each(["client", "ssr"])("skips Nuxt %s environment render cleanup", async (environmentName) => {
    await runRenderFailureLifecycle(createPlugin(true), environmentName)

    expect(lifecycle.capture).not.toHaveBeenCalled()
    expect(lifecycle.retainSources).not.toHaveBeenCalled()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.removeArtifactDir).not.toHaveBeenCalled()
  })

  it("runs Provider Output work in the final Nitro environment", async () => {
    await runSuccessfulProviderLifecycle(createPlugin(true), "nitro")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })

  it("cleans staged Provider Output after a final Nitro render failure", async () => {
    await runRenderFailureLifecycle(createPlugin(true), "nitro")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.reset).toHaveBeenCalledOnce()
    expect(lifecycle.removeArtifactDir).toHaveBeenCalledOnce()
    expect(lifecycle.finalize).not.toHaveBeenCalled()
  })

  it("keeps Provider Output work in plain Vite client builds", async () => {
    await runSuccessfulProviderLifecycle(createPlugin(false), "client")

    expect(lifecycle.capture).toHaveBeenCalledOnce()
    expect(lifecycle.retainSources).toHaveBeenCalledOnce()
    expect(lifecycle.writeProviderEntries).toHaveBeenCalledOnce()
    expect(lifecycle.contribute).toHaveBeenCalledOnce()
    expect(lifecycle.reset).not.toHaveBeenCalled()
    expect(lifecycle.finalize).toHaveBeenCalledOnce()
  })
})
