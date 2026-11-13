import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assertFeaturePackages, forgetPackageChecks, isPackageInstalled, missingFeaturePackagesError, startPackageChecks } from "../src/internal/optional-owners.ts"

vi.mock("../src/internal/optional-owners.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../src/internal/optional-owners.ts")>()
  return {
    ...original,
    assertFeaturePackages: vi.fn(original.assertFeaturePackages),
    forgetPackageChecks: vi.fn(original.forgetPackageChecks),
    isPackageInstalled: vi.fn(original.isPackageInstalled),
    startPackageChecks: vi.fn(original.startPackageChecks),
  }
})

const kvCacheDriver = "/kv/dist/runtime/nitro-cache.js"

vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) }
})

const integrationMocks = vi.hoisted(() => ({
  discoverAgentDefinitionEntries: vi.fn(() => []),
  denoServerPackagesPlugin: vi.fn((onPackages: (packages: { bundledPackageDirs: string[], externalImports: [] }) => void) => {
    onPackages({ bundledPackageDirs: [], externalImports: [] })
    return { name: "vitehub:deno-server-packages" }
  }),
  discoverWorkflowDefinitions: vi.fn(() => []),
  finalizeDenoDeploymentOutput: vi.fn(),
  finalizeDeploymentPlanOutput: vi.fn(),
  hubAgent: vi.fn(() => ({ name: "@vite-hub/agent/vite" })),
  hubAuth: vi.fn(() => ({ name: "@vite-hub/auth/vite" })),
  hubBlob: vi.fn((..._args: Parameters<typeof import("../../blob/src/vite.ts").hubBlob>) => ({ name: "@vite-hub/blob/vite" })),
  resolveBlobViteConfig: vi.fn((blob?: { driver?: string, stores?: Record<string, unknown> }, input?: { hosting?: string }) => ({
    blob: {
      store: blob?.driver ? { driver: blob.driver } : input?.hosting === "cloudflare-module" ? { driver: "cloudflare-r2" } : undefined,
      stores: blob?.stores,
    },
  })),
  hubBrowser: vi.fn(() => ({ name: "@vite-hub/browser/vite" })),
  hubChannels: vi.fn(() => ({ name: "@vite-hub/channels/vite" })),
  hubDb: vi.fn(() => ({ name: "@vite-hub/database/vite" })),
  hubEmail: vi.fn(() => ({ name: "@vite-hub/email/vite" })),
  hubEmailOptionalPeerResolver: vi.fn(() => ({ name: "@vite-hub/email/optional-peer-resolver" })),
  hubEnv: vi.fn((options?: { projectRoot?: string }) => ({
    api: {
      createServerEnvRegistry: () => ({}),
      getServerEnvRegistry: () => ({}),
      onServerEnvRegistry: () => {},
      resolveDeclarations: () => undefined,
      resolveProjectRoot: (viteRoot: string) => options?.projectRoot ? join(viteRoot, options.projectRoot) : viteRoot,
    },
    name: "@vite-hub/env/vite",
  })),
  hubKv: vi.fn(() => ({ name: "@vite-hub/kv/vite" })),
  hubKvOptionalPeerResolver: vi.fn(() => ({ name: "@vite-hub/kv/optional-peers" })),
  resolveKVViteConfig: vi.fn((kv?: { driver?: string, stores?: Record<string, { driver: string }> }, input?: { hosting?: string }) => ({
    kv: kv?.stores
      ? { stores: kv.stores }
      : { store: kv?.driver ? { driver: kv.driver } : input?.hosting === "cloudflare-module" ? { driver: "cloudflare-kv-binding" } : { driver: "fs-lite", inferred: true } },
  })),
  resolveAuthViteConfig: vi.fn(),
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
  hubRateLimit: vi.fn(() => ({ name: "@vite-hub/rate-limit/vite" })),
  hubSandboxTask: vi.fn(() => ({ name: "@vite-hub/sandbox/task/vite" })),
  hubSchedule: vi.fn(() => ({ name: "@vite-hub/schedule/vite" })),
  hubWorkflow: vi.fn(() => ({ name: "@vite-hub/workflow/vite" })),
  hubWorkspace: vi.fn(() => ({ name: "@vite-hub/workspace/vite" })),
  viteHubTask: vi.fn(() => ({ name: "vite-hub/task" })),
  consoleSection: (id: string) => ({
    description: id,
    icon: "i-lucide-box",
    id,
    label: id,
    read: () => [],
    view: { kind: "definition-catalog" as const, notice: id },
  }),
}))

vi.mock("@vite-hub/agent/vite", () => ({
  agentRuntimeModule: (entry: string) => `/agent/dist/${entry}.js`,
  discoverAgentDefinitionEntries: integrationMocks.discoverAgentDefinitionEntries,
  hubAgent: integrationMocks.hubAgent,
}))
vi.mock("@vite-hub/internal/build/deno-runtime-packages", () => ({
  denoServerPackagesPlugin: integrationMocks.denoServerPackagesPlugin,
  finalizeDenoDeploymentOutput: integrationMocks.finalizeDenoDeploymentOutput,
}))
vi.mock("@vite-hub/internal/build/deployment-plan-output", () => ({
  finalizeDeploymentPlanOutput: integrationMocks.finalizeDeploymentPlanOutput,
}))
vi.mock("@vite-hub/auth/vite", () => ({
  hubAuth: integrationMocks.hubAuth,
  resolveAuthViteConfig: integrationMocks.resolveAuthViteConfig,
}))
vi.mock("@vite-hub/blob/vite", () => ({
  hubBlob: integrationMocks.hubBlob,
  resolveBlobViteConfig: integrationMocks.resolveBlobViteConfig,
}))
vi.mock("@vite-hub/browser/vite", () => ({ hubBrowser: integrationMocks.hubBrowser }))
vi.mock("@vite-hub/channels/vite", () => ({ hubChannels: integrationMocks.hubChannels }))
vi.mock("@vite-hub/database/vite", async importOriginal => ({
  ...await importOriginal<typeof import("@vite-hub/database/vite")>(),
  hubDb: integrationMocks.hubDb,
}))
vi.mock("@vite-hub/email/vite", () => ({
  emailConsoleSection: integrationMocks.consoleSection("email"),
  hubEmail: integrationMocks.hubEmail,
  hubEmailOptionalPeerResolver: integrationMocks.hubEmailOptionalPeerResolver,
}))
vi.mock("@vite-hub/env/vite", async importOriginal => ({
  ...await importOriginal<typeof import("@vite-hub/env/vite")>(),
  hubEnv: integrationMocks.hubEnv,
}))
vi.mock("@vite-hub/kv/vite", () => ({
  hubKv: integrationMocks.hubKv,
  hubKvOptionalPeerResolver: integrationMocks.hubKvOptionalPeerResolver,
  kvNitroCacheDriver: "/kv/dist/runtime/nitro-cache.js",
  resolveKVViteConfig: integrationMocks.resolveKVViteConfig,
}))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: integrationMocks.hubQueue, queueConsoleSection: integrationMocks.consoleSection("queues") }))
vi.mock("@vite-hub/rate-limit/vite", () => ({ hubRateLimit: integrationMocks.hubRateLimit, rateLimitConsoleSection: integrationMocks.consoleSection("rate-limits") }))
vi.mock("@vite-hub/sandbox/task/vite", () => ({ hubSandboxTask: integrationMocks.hubSandboxTask, sandboxTaskConsoleSection: integrationMocks.consoleSection("sandbox-tasks"), sandboxTaskRuntimeStateModule: "/sandbox/dist/task/runtime/state.js" }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: integrationMocks.hubSchedule, scheduleConsoleSection: integrationMocks.consoleSection("schedules") }))
vi.mock("@vite-hub/workflow/vite", () => ({
  discoverWorkflowDefinitions: integrationMocks.discoverWorkflowDefinitions,
  hubWorkflow: integrationMocks.hubWorkflow,
  workflowConsoleSection: integrationMocks.consoleSection("workflows"),
  workflowRuntimeModule: (entry: string) => `/workflow/dist/runtime/${entry}.js`,
}))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: integrationMocks.hubWorkspace, workspaceConsoleSection: integrationMocks.consoleSection("workspaces") }))
vi.mock("../src/task/vite.ts", () => ({ viteHubTaskPlugin: integrationMocks.viteHubTask }))

import { getResolvedFeatureOptions, VITEHUB_FEATURES, VITEHUB_NITRO_CONFIG_CONTEXT } from "@vite-hub/internal/build/vite"
import { resolveConfig, type Plugin, type PluginOption } from "vite"
import { contributeProviderDeploymentOutput, useProviderOutputCatalog } from "../../internal/src/build/deployment-output.ts"
import frameworkPackageManifest from "../package.json" with { type: "json" }
import { vitehub, type ViteHubOptions } from "../src/index.ts"
import { ownerModules } from "../src/internal/owner-modules.ts"
import { isIncludedNitroPlugin } from "../src/nitro-plugin.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

const deniedGeneratedOwnerPackageNames = new Set(["@vite-hub/bundle", "@vite-hub/cli", "@vite-hub/codemods", "@vite-hub/console-client", "@vite-hub/web-container"])
const generatedOwnerPackageCases = Object.keys({ ...frameworkPackageManifest.dependencies, ...frameworkPackageManifest.peerDependencies })
  .filter(name => name.startsWith("@vite-hub/"))
  .map(name => [name, deniedGeneratedOwnerPackageNames.has(name) ? "deny" : "resolve"] as const)

function ownerPackageImportSpecifier(name: string): string {
  const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`${name}/package.json`)), "utf8"))
  const subpaths = Object.keys(Object(Reflect.get(Object(manifest), "exports")))
  if (subpaths.includes(".")) return name
  const subpath = subpaths.find(candidate => candidate.startsWith("./") && candidate !== "./package.json")
  if (!subpath) throw new TypeError(`Expected ${name} to export an entry.`)
  return `${name}/${subpath.slice(2)}`
}

// SAFETY: Resolver tests below do not read the Vite plugin context.
const pluginContext = {} as never
// SAFETY: Resolver tests below do not read the Vite resolve options.
const pluginResolveOptions = {} as never

function pluginNames(plugins: PluginOption[]): string[] {
  // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
  return (plugins.flat() as Plugin[]).filter(plugin => !isIncludedNitroPlugin(plugin)).map(plugin => plugin.name)
}

/** Names of the plugins that Vite keeps for an app without `server/content.ts`. */
function appliedPluginNames(plugins: PluginOption[]): string[] {
  // SAFETY: vitehub() returns concrete plugins, and the included Nitro plugins as one nested list.
  return (plugins.flat() as Plugin[]).filter(plugin => !isIncludedNitroPlugin(plugin)).filter(plugin => plugin.apply === undefined
    || (plugin.apply instanceof Function ? plugin.apply({ root: "/vitehub-test-app-without-content" }, { command: "build", mode: "production" }) : plugin.apply === "build"))
    .map(plugin => plugin.name)
}

function isCallable(value: unknown): value is CallableFunction {
  if (value === null || value === undefined || Object(value) !== value) return false
  try {
    Function.prototype.toString.call(value)
    return true
  }
  catch {
    return false
  }
}

function isRuntimeRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && Object(value) === value && !isCallable(value)
}

function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRuntimeRecord(value) && Object.values(value).every(isString)
}

function dependencyResolver() {
  return filteredResolveId(dependencyPlugin({ host: "node", blob: true }))
}

/** Skips the hook for an id that its filter rejects, as Rolldown and Vite do. */
function matchesIdFilter(hook: unknown, id: unknown): boolean {
  const filter = isRuntimeRecord(hook) ? hook.filter : undefined
  if (!isRuntimeRecord(filter) || !("id" in filter)) return true
  return typeof id === "string" && [filter.id].flat().some(pattern => pattern instanceof RegExp && pattern.test(id))
}

function filteredResolveId(plugin: Plugin) {
  const hook = plugin.resolveId
  const handler = isRuntimeRecord(hook) && "handler" in hook ? hook.handler : hook
  if (!isCallable(handler)) throw new TypeError(`Expected the ${plugin.name} resolver.`)
  return function (this: unknown, id: string, ...args: unknown[]): unknown {
    return matchesIdFilter(hook, id) ? Reflect.apply(handler, this, [id, ...args]) : undefined
  }
}

function callHook(hook: unknown, args: readonly unknown[]): unknown {
  const candidate = isCallable(hook)
    ? hook
    : isRuntimeRecord(hook) && "handler" in hook
      ? hook.handler
      : undefined
  if (!isCallable(candidate)) throw new TypeError("Expected a callable plugin hook.")
  if (!matchesIdFilter(hook, args[0])) return undefined
  return Reflect.apply(candidate, undefined, args)
}

function providerAliasesFromCall(call: readonly unknown[] | undefined, index = 0): Record<string, string> {
  const value = call?.[index]
  if (!isRuntimeRecord(value) || !("providerImportAliases" in value)) {
    throw new TypeError("Expected provider import aliases in the integration call.")
  }
  const aliases = value.providerImportAliases
  if (!isStringRecord(aliases)) {
    throw new TypeError("Expected provider import aliases to be a string record.")
  }
  // SAFETY: The preceding check validates every alias value.
  return aliases as Record<string, string>
}

function pluginAliasEntries(plugin: Plugin): { find: RegExp, replacement: string }[] {
  const config = callHook(plugin.config, [{}])
  if (!isRuntimeRecord(config) || !("resolve" in config)) throw new TypeError("Expected plugin resolve configuration.")
  const resolve = config.resolve
  if (!isRuntimeRecord(resolve) || !("alias" in resolve) || !Array.isArray(resolve.alias)) throw new TypeError("Expected plugin aliases.")
  return resolve.alias.map((entry: unknown) => {
    if (!isRuntimeRecord(entry) || !(entry.find instanceof RegExp) || typeof entry.replacement !== "string") {
      throw new TypeError("Expected each plugin alias to be an exact pattern and a path.")
    }
    return { find: entry.find, replacement: entry.replacement }
  })
}

/** The plugin's aliases by the one specifier each pattern matches. */
function pluginAliases(plugin: Plugin): Record<string, string> {
  return Object.fromEntries(pluginAliasEntries(plugin).map(({ find, replacement }) => [find.source.slice(1, -1).replace(/\\(.)/g, "$1"), replacement]))
}

type ProviderImportPlugin = Plugin & {
  vitehub: { providerOutput: { getImportAliases: () => Promise<Record<string, string>> | Record<string, string> } }
}

function dependencyPlugin(options: Parameters<typeof vitehub>[0] = { host: "node" }): ProviderImportPlugin {
  // SAFETY: The test asserts below that the named plugin exists before returning it.
  const plugin = vitehub(options).find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as ProviderImportPlugin | undefined
  if (!plugin) throw new TypeError("Expected the framework dependency resolver.")
  return plugin
}

async function providerOutputAliases(plugin: ProviderImportPlugin): Promise<Record<string, string>> {
  return await plugin.vitehub.providerOutput.getImportAliases() ?? {}
}

async function applyDeploymentConfig(
  options: Parameters<typeof vitehub>[0],
  config: Record<string, unknown> = {},
  command: "build" | "serve" = "build",
): Promise<Record<string, unknown>> {
  const plugin = dependencyPluginByName(vitehub(options), "vite-hub/deployment-host")
  await callHook(plugin.config, [config, { command, mode: command === "build" ? "production" : "development" }])
  return config
}

function dependencyPluginByName(plugins: PluginOption[], name: string): Plugin {
  const plugin = plugins.find(candidate => isRuntimeRecord(candidate) && Reflect.get(candidate, "name") === name)
  if (!plugin) throw new TypeError(`Expected the ${name} plugin.`)
  // SAFETY: The runtime name check above identifies the concrete Vite plugin in this flat plugin list.
  return plugin as Plugin
}

describe("vitehub", () => {
  it("reads owner manifests only when provider output needs aliases and reuses the result", async () => {
    vi.resetModules()
    vi.mocked(readFileSync).mockClear()
    const ownerManifestPaths = new Set(generatedOwnerPackageCases
      .filter(([, access]) => access === "resolve")
      .map(([name]) => fileURLToPath(import.meta.resolve(`${name}/package.json`))))
    const ownerReads = () => vi.mocked(readFileSync).mock.calls
      .filter(([path]) => typeof path === "string" && ownerManifestPaths.has(path))
    const { vitehub: freshVitehub } = await import("../src/index.ts")
    const plugins = freshVitehub({ host: "node" })
    // SAFETY: The named dependency plugin owns the provider-output alias callback.
    const plugin = dependencyPluginByName(plugins, "vite-hub/dependencies") as ProviderImportPlugin

    expect(ownerReads()).toHaveLength(0)
    const aliases = await plugin.vitehub.providerOutput.getImportAliases()
    expect(aliases["@vite-hub/agent"]).toBe(fileURLToPath(import.meta.resolve("@vite-hub/agent")))
    expect(ownerReads()).toHaveLength(ownerManifestPaths.size)
    expect(await plugin.vitehub.providerOutput.getImportAliases()).toBe(aliases)
    expect(ownerReads()).toHaveLength(ownerManifestPaths.size)
  })

  it.each([
    ["default", "export default {}", "server"],
    ["custom", 'export default { serverDir: "custom-server" }', "custom-server"],
    ["disabled", "export default { serverDir: false }", false],
    ["legacy srcDir", 'export default { srcDir: "custom-server" }', false],
    ["dotenv", "export default { serverDir: process.env.VITEHUB_TEST_SERVER_DIR }", "custom-server"],
    ["dotenv opt-out", 'export default { serverDir: process.env.VITEHUB_TEST_SERVER_DIR ? false : undefined }', false],
  ] as const)("resolves Nitro routes once with %s configuration", async (_name, source, serverDir) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-server-dir-"))
    const { createNitro } = await import("nitro/builder")
    try {
      await mkdir(join(root, "server/api"), { recursive: true })
      await mkdir(join(root, "custom-server/api"), { recursive: true })
      for (const directory of ["server", "custom-server"]) {
        for (const feature of ["plugins", "modules", "tasks"]) {
          await mkdir(join(root, directory, feature), { recursive: true })
        }
        await writeFile(join(root, directory, "plugins/example.ts"), "export default () => {}")
        await writeFile(join(root, directory, "modules/example.ts"), `export default { setup(nitro) { nitro.options.runtimeConfig.scannedModule = ${JSON.stringify(directory)} } }`)
        await writeFile(join(root, directory, "tasks/example.ts"), "export default { run() { return {} } }")
      }
      await writeFile(join(root, "server/api/default.ts"), "export default () => 'default'")
      await writeFile(join(root, "custom-server/api/custom.ts"), "export default () => 'custom'")
      await writeFile(join(root, ".env.production"), "VITEHUB_TEST_SERVER_DIR=custom-server")
      await writeFile(join(root, "nitro.config.ts"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(root, "loads"))}, "load\\n"); ${source}`)
      const preset = dependencyPluginByName(vitehub({ host: "node" }), "vite-hub/deployment-host")
      const config = { root, nitro: {} }
      await callHook(preset.config, [config, { command: "build", mode: "production" }])
      await expect(readFile(join(root, "loads"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      expect(preset.nitro).toBeDefined()
      const nitro = await createNitro({ ...config.nitro, rootDir: root, builder: "vite", experimental: { tasks: true }, modules: [preset.nitro!] }, {
        dotenv: { fileName: [".env", ".env.local", ".env.production", ".env.production.local"] },
      })
      try {
        expect(nitro.options.serverDir).toBe(serverDir === false ? false : `${join(root, serverDir)}/`)
        expect(nitro.scannedHandlers.map(handler => handler.route)).toEqual(serverDir === false ? [] : [serverDir === "server" ? "/api/default" : "/api/custom"])
        if (serverDir !== false) {
          expect(nitro.options.plugins).toContain(join(root, serverDir, "plugins/example.ts"))
          expect(nitro.options.tasks.example?.handler).toBe(join(root, serverDir, "tasks/example.ts"))
          expect(nitro.options.runtimeConfig.scannedModule).toBe(serverDir)
        }
        else {
          expect(nitro.options.plugins.some(plugin => plugin.endsWith("plugins/example.ts"))).toBe(false)
          expect(nitro.options.tasks.example).toBeUndefined()
          expect(nitro.options.runtimeConfig.scannedModule).toBeUndefined()
        }
        expect(await readFile(join(root, "loads"), "utf8")).toBe("load\n")
      }
      finally {
        await nitro.close()
      }
    }
    finally {
      delete process.env.VITEHUB_TEST_SERVER_DIR
      await rm(root, { recursive: true, force: true })
    }
  })

  it("serializes the built-in Provider Output finalizer", () => {
    const output = dependencyPluginByName(vitehub({ host: "node" }), "vite-hub/deployment-output")

    expect(output.closeBundle).toMatchObject({ order: "post", sequential: true })
  })

  it("discards Provider Output after an output-phase build failure", async () => {
    const plugins = vitehub({ host: "node" })
    const preset = dependencyPluginByName(plugins, "vite-hub/deployment-host")
    const output = dependencyPluginByName(plugins, "vite-hub/deployment-output")
    const config: Record<string, unknown> = { ...await resolveConfig({}, "build") }
    await callHook(preset.config, [config, { command: "build", mode: "production" }])
    config.plugins = plugins
    callHook(output.configResolved, [config])

    const catalog = useProviderOutputCatalog(config)
    const write = vi.fn()
    contributeProviderDeploymentOutput(catalog, { owner: "agent", rootDir: "/app", write })

    await callHook(output.renderError, [new Error("output failed")])
    await callHook(output.closeBundle, [])

    expect(write).not.toHaveBeenCalled()
  })

  it("installs the console and adds the Agent runtime bridge only when Agents are active", () => {
    expect(pluginNames(vitehub({ console: { auth: false }, host: "node" }))).toContain("vite-hub/console")
    expect(pluginNames(vitehub({ console: { auth: false }, host: "node" }))).not.toContain("vite-hub/console-invocation-root")
    expect(pluginNames(vitehub({ agent: true, console: { auth: false }, host: "node" }))).toEqual(
      expect.arrayContaining(["vite-hub/console", "vite-hub/console-invocation-root"]),
    )
  })

  it("includes implicitly enabled Workflow in the Agent Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-agent-workflow-"))
    try {
      const plugin = dependencyPluginByName(
        vitehub({ agent: true, comments: false, console: { auth: false }, host: "node" }),
        "vite-hub/console",
      )
      const config: Record<string, unknown> = { root }

      await callHook(plugin.config, [config, { command: "serve", mode: "development" }])

      expect(config.nitro).toMatchObject({
        handlers: expect.arrayContaining([
          expect.objectContaining({ route: "/_vitehub/rpc" }),
        ]),
      })
      await expect(readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")).resolves.toContain(
        `installConsoleSections(${JSON.stringify(root)}, ["setup","env","agents","skills","usage","channels","workflows"])`,
      )
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("takes no options", () => {
    expect(pluginNames(vitehub())).toContain("vite-hub/deployment-host")
  })

  it("passes the Queue options of the app with the host's provider to the deployment config", async () => {
    const config = await applyDeploymentConfig({ name: "jobs-app", host: "cloudflare", queue: { cache: true } })
    expect(getResolvedFeatureOptions(config, "queue")).toEqual({ cache: true, namePrefix: "jobs-app-", provider: "cloudflare" })
  })

  it("does not install console plugins when explicitly disabled", () => {
    expect(pluginNames(vitehub({ console: false, host: "node" }))).not.toEqual(expect.arrayContaining([
      "vite-hub/console",
      "vite-hub/console-invocation-root",
    ]))
  })

  it("refuses a host-managed Console in a production build on Cloudflare", async () => {
    const plugin = dependencyPluginByName(
      vitehub({ agent: true, console: { auth: false, authorize: hostManagedAuthorize }, host: "cloudflare" }),
      "vite-hub/console",
    )

    await expect(callHook(plugin.config, [{}, { command: "build", mode: "production" }]))
      .rejects.toMatchObject({ code: "VITE_HUB_B0022" })
    await expect(callHook(plugin.config, [{}, { command: "serve", mode: "development" }]))
      .resolves.toBeUndefined()
  })

  it("derives Console KV registration from the resolved Vite KV configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-kv-"))
    try {
      for (const [name, kv] of [["omitted", undefined], ["disabled", false]] as const) {
        const inactiveRoot = join(root, name)
        const inactive = dependencyPluginByName(
          vitehub({ comments: false, console: { auth: false }, kv, host: "node" }),
          "vite-hub/console",
        )
        const inactiveConfig: Record<string, unknown> = { root: inactiveRoot }
        await callHook(inactive.config, [inactiveConfig, { command: "serve", mode: "development" }])
        await callHook(inactive.configResolved, [inactiveConfig])

        const inactiveGenerated = await readFile(join(inactiveRoot, ".vitehub/nitro/console/plugin.mjs"), "utf8")
        expect(inactiveGenerated).not.toContain('"kv"')
        expect(inactiveConfig.nitro).not.toMatchObject({
          handlers: expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/api/kv" })]),
        })
      }

      const named = dependencyPluginByName(
        vitehub({ comments: false, console: { auth: false }, kv: true, host: "node" }),
        "vite-hub/console",
      )
      const namedConfig: Record<string, unknown> = { root }
      await callHook(named.config, [namedConfig, { command: "serve", mode: "development" }])
      expect(namedConfig.nitro).toMatchObject({
        handlers: expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/rpc" })]),
      })
      await callHook(named.configResolved, [namedConfig])

      const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('"kv"')
      expect(generated).not.toContain("installConsoleKV")
      expect(namedConfig.nitro).toMatchObject({
        handlers: expect.arrayContaining([expect.objectContaining({ route: "/_vitehub/rpc" })]),
      })

    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("derives Console Blob stores from the resolved Vite Blob configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-blob-stores-"))
    try {
      const plugin = dependencyPluginByName(
        vitehub({ blob: true, comments: false, console: { auth: false }, host: "node" }),
        "vite-hub/console",
      )
      const config: Record<string, unknown> = { root }
      await callHook(plugin.config, [config, { command: "serve", mode: "development" }])
      config[VITEHUB_FEATURES] = { blob: { stores: { archive: { driver: "memory" }, media: { driver: "memory" } } } }
      await callHook(plugin.configResolved, [config])

      const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('installConsoleBlob(')
      expect(generated).toContain('["archive","media"]')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps local operation runtime installers with Setup-only navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-setup-operations-"))
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      await mkdir(join(root, "server"), { recursive: true })
      await writeFile(join(root, "server/content.ts"), [
        "import { defineContent } from 'vite-hub/content'",
        "import { documents } from 'vite-hub/content/collections'",
        "import cms from 'vite-hub/cms'",
        "export const content = defineContent({ extends: cms, collections: { posts: documents({ path: 'posts/*.md', fields: {} }) } })",
        "export default content",
      ].join("\n"))
      const plugin = dependencyPluginByName(vitehub({ blob: true, database: true, host: "node", workspace: true }), "vite-hub/console")
      const config = { root, [VITEHUB_FEATURES]: { database: { connection: { url: "file::memory:" } } } }
      await callHook(plugin.config, [config, { command: "serve", mode: "development" }])
      await callHook(plugin.configResolved, [config])
      const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain(`installConsoleBlob(${JSON.stringify(root)}, vitehubConsoleBlob, ["default"])`)
      expect(generated).toContain(`installConsoleDatabase(${JSON.stringify(root)}, vitehubConsoleDatabases, ["default"])`)
      expect(generated).toContain(`installConsoleDocuments(${JSON.stringify(root)}, { "content":`)
      expect(generated).toMatch(/installConsoleSections\([^\n]+"blob"[^\n]+\["setup"\]\)/)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("adds no Vite DevTools dock, since apps serve no Console page", () => {
    const plugin = dependencyPluginByName(vitehub({ console: { auth: false }, host: "node" }), "vite-hub/console")
    expect(plugin).not.toHaveProperty("devtools")
  })

  it("keeps an application KV route beside the Console RPC route", async () => {
    const plugin = dependencyPluginByName(
      vitehub({ console: { auth: false }, kv: true, host: "node" }),
      "vite-hub/console",
    )

    const config = {
      nitro: {
        handlers: [{
          handler: "/app/server/api/custom-kv.ts",
          route: "/_vitehub/api/kv",
        }],
      },
    }
    await callHook(plugin.config, [config, { command: "serve", mode: "development" }])
    expect(config.nitro.handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: "/_vitehub/api/kv" }),
      expect.objectContaining({ route: "/_vitehub/rpc" }),
    ]))
  })

  it("adds the Auth section and its impersonation route to a production Console with app Auth", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      integrationMocks.resolveAuthViteConfig.mockReturnValueOnce({ access: { routes: [] } })
      const plugin = dependencyPluginByName(vitehub({ agent: true, auth: true, console: true, host: "node" }), "vite-hub/console")
      const config: { nitro?: { handlers?: Array<{ route?: string }> }, root: string } = { root }

      await callHook(plugin.config, [config, { command: "build", mode: "production" }])

      expect(integrationMocks.resolveAuthViteConfig).toHaveBeenCalledWith(undefined, root, { serverDirs: undefined })
      const routes = config.nitro?.handlers?.map(handler => handler.route)
      expect(routes).toContain("/_vitehub/rpc")
      expect(routes).not.toContain("/_vitehub/auth/manage")
      expect(routes).not.toContain("/_vitehub/sign-in")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("adds no Auth owner for the Console alone", () => {
    expect(pluginNames(vitehub({ console: true, host: "node" }))).not.toContain("@vite-hub/auth/vite")
  })

  it("omits implicitly disabled Netlify Workflow from the standalone Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-netlify-workflow-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const implicit = dependencyPluginByName(
        vitehub({ agent: { invocations: false }, console: { auth: false, authorize: hostManagedAuthorize }, host: "netlify" }),
        "vite-hub/console",
      )
      const implicitConfig: { nitro?: { handlers?: Array<{ route?: string }> }; root: string } = { root }
      await callHook(implicit.config, [implicitConfig, { command: "serve", mode: "development" }])

      expect(implicitConfig).toMatchObject({
        nitro: {
          handlers: expect.arrayContaining([
            expect.objectContaining({ route: "/_vitehub/rpc" }),
          ]),
        },
      })

      const explicit = dependencyPluginByName(
        vitehub({
          agent: { invocations: false },
          console: { auth: false, authorize: hostManagedAuthorize },
          host: "netlify",
          workflow: { provider: "vercel" },
        }),
        "vite-hub/console",
      )
      const explicitConfig: { nitro?: { handlers?: Array<{ route?: string }> }; root: string } = { root }
      await callHook(explicit.config, [explicitConfig, { command: "serve", mode: "development" }])

      expect(explicitConfig).toMatchObject({
        nitro: {
          handlers: expect.arrayContaining([
            expect.objectContaining({ route: "/_vitehub/rpc" }),
          ]),
        },
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps dependency discovery for an explicitly inlined workerd service", async () => {
    const config = await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [
        dependencyPluginByName(vitehub({ host: "cloudflare" }), "vite-hub/deployment-settings"),
        {
          name: "nitro-service-stand-in",
          configEnvironment(name) {
            if (name === "api") return { consumer: "server", resolve: { conditions: ["workerd"] } }
          },
        },
      ],
      environments: { api: { resolve: { noExternal: true } } },
    }, "serve")

    expect(config.environments.api!.optimizeDeps.noDiscovery).toBe(false)
    expect(config.environments.api!.optimizeDeps.exclude).toContain("nitro")
  })

  it("includes Nitro once, and steps aside when the app adds nitro()", () => {
    const included = (vitehub({ host: "node" }).flat() as Plugin[]).filter(isIncludedNitroPlugin)
    const main = included.find(plugin => plugin.name === "nitro:main")!
    const apply = main.apply as (config: { plugins?: unknown[] }, env: { command: "build" | "serve", mode: string }) => boolean
    const env = { command: "build" as const, mode: "production" }
    expect(apply({ plugins: [included] }, env)).toBe(true)
    expect(apply({ plugins: [included, [{ name: "nitro:init" }, { name: "nitro:main" }]] }, env)).toBe(false)
  })

  it("keeps coherent defaults and opt-in integrations", () => {
    // Database, Blob, and Workspace are in the list for the `cms` preset, which turns them on when it is used.
    expect(pluginNames(vitehub({ host: "node" }))).toEqual(expect.arrayContaining(["@vite-hub/database/vite", "@vite-hub/blob/vite", "@vite-hub/workspace/vite"]))
    expect(appliedPluginNames(vitehub({ host: "node" }))).toEqual([
      "vite-hub/doctor",
      "@vite-hub/markdown-template/vite",
      "vite-hub/deployment-settings",
      "vite-hub/deployment-host",
      "vite-hub/deployment-output",
      "vite-hub/public-url",
      "vite-hub/standard-context",
      "vite-hub/database-disabled",
      "vite-hub/unavailable-services",
      "vite-hub/dependencies",
      "vite-hub/error-log",
      "@vite-hub/env/vite",
      "vite-hub/operations",
      "@vite-hub/connections/types-cleanup",
      "@vite-hub/email/optional-peer-resolver",
      "@vite-hub/kv/optional-peers",
      "@vite-hub/source/vite",
      "@vite-hub/content/vite",
      "@vite-hub/forms/vite",
      "@vite-hub/cms/vite",
      "@vite-hub/comments/vite",
      "vite-hub/optional-owner-imports",
      "vite-hub/task",
      "vite-hub/durability/nitro",
      "vite-hub/durability",
      "vite-hub/nitro-cache-bypass",
      "vite-hub/types",
      "vite-hub/nitro-order",
      "vite-hub/nitro-order/run",
    ])

    expect(pluginNames(vitehub({
      agent: true,
      auth: true,
      blob: true,
      database: true,
      email: { driver: "resend" },
      channels: true,
      kv: true,
      host: "cloudflare",
      rateLimit: true,
      sandboxTask: true,
      schedule: true,
      workflow: true,
      workspace: true,
    }))).toEqual([
      "vite-hub/doctor",
      "@vite-hub/markdown-template/vite",
      "vite-hub/agent-channel-env",
      "vite-hub/deployment-settings",
      "vite-hub/deployment-host",
      "vite-hub/deployment-output",
      "vite-hub/public-url",
      "vite-hub/dev-defines",
      "vite-hub/standard-context",
      "vite-hub/workspace-shell",
      "vite-hub/unavailable-services",
      "vite-hub/cloudflare-sh-syntax",
      "vite-hub/cloudflare-pkce-challenge",
      "vite-hub/dependencies",
      "vite-hub/error-log",
      "@vite-hub/env/vite",
      "vite-hub/setup-dev",
      "vite-hub/operations",
      "vite-hub/console",
      "@vite-hub/auth/vite",
      "@vite-hub/sandbox/task/vite",
      "vite-hub/agent-invocations",
      "@vite-hub/agent/vite",
      "@vite-hub/channels/vite",
      "@vite-hub/connections/types-cleanup",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/email/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/rate-limit/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "@vite-hub/source/vite",
      "@vite-hub/content/vite",
      "@vite-hub/forms/vite",
      "@vite-hub/cms/vite",
      "@vite-hub/comments/vite",
      "vite-hub/optional-owner-imports",
      "vite-hub/task",
      "vite-hub/nitro-cache-bypass",
      "vite-hub/types",
      "vite-hub/nitro-order",
      "vite-hub/nitro-order/run",
    ])
    expect((vitehub({ host: "node" }).flat() as Plugin[]).filter(isIncludedNitroPlugin).map(plugin => plugin.name)).toContain("nitro:main")
    expect(pluginNames(vitehub({ host: "node", sandboxTask: false }))).not.toContain("@vite-hub/sandbox/task/vite")
    expect(pluginNames(vitehub({ agent: true, host: "node" }))).toContain("@vite-hub/workflow/vite")
    expect(pluginNames(vitehub({ agent: true, host: "node", workflow: false }))).not.toContain("@vite-hub/workflow/vite")

    vitehub({
      agent: true,
      blob: true,
      database: true,
      host: "node",
      schedule: true,
      workflow: true,
      workspace: true,
    })

    expect(integrationMocks.hubAuth).toHaveBeenLastCalledWith({}, {
      importBase: "vite-hub/auth",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith({
      kvImport: "vite-hub/kv",
      processDiscordGateway: true,
      providerImportAliases: {
        "@vite-hub/kv/runtime/redis-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-redis-driver\.(?:ts|js)$/),
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-upstash-driver\.(?:ts|js)$/),
      },
      runtimeCapabilityImports: {
        auth: "vite-hub/auth/agent",
        blob: "vite-hub/blob",
        connections: false,
        console: false,
        db: "@vite-hub/database/runtime/registry",
        email: "vite-hub/email",
        i18n: false,
        kv: "vite-hub/kv",
      },
      workflowModules: { index: "vite-hub/workflow", state: "/workflow/dist/runtime/state.js" },
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    })
    expect(integrationMocks.hubAgent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith({ driver: "fs" }, {
      importBase: "vite-hub/blob",
      presetDriver: expect.any(Function),
    })
    expect(integrationMocks.hubDb).toHaveBeenLastCalledWith(undefined)
    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      driver: "resend",
      hosting: "cloudflare-module",
      runtimeEnvImport: expect.stringMatching(/[\\/]env[\\/]dist[\\/]internal[\\/]server\.js$/),
      workflowProvider: undefined,
    })
    expect(integrationMocks.hubChannels).toHaveBeenLastCalledWith(undefined)
    // hubKv() infers the driver itself, so `vite dev` can keep the store local.
    expect(integrationMocks.hubKv).toHaveBeenCalledWith(undefined, { databaseImport: "@vite-hub/database/runtime/registry", hosting: "cloudflare-module" })
    // With `kv` unset, the list also has the KV case for a `github()` Content Source.
    expect(integrationMocks.hubKv).toHaveBeenLastCalledWith(undefined, { databaseImport: "@vite-hub/database/runtime/registry", hosting: "node-server" })
    expect(integrationMocks.hubSandboxTask).toHaveBeenLastCalledWith({
      provider: "cloudflare",
      providerImportAliases: expect.any(Object),
      providerImportSpecifier: "vite-hub/sandbox/task",
    })
    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith({
      databaseImport: "@vite-hub/database/runtime/registry",
      importBase: "vite-hub/schedule",
      providerImportAliases: {
        "@vite-hub/kv/runtime/redis-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-redis-driver\.(?:ts|js)$/),
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-upstash-driver\.(?:ts|js)$/),
      },
    })
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, {
      hosting: "node-server",
      importBase: "vite-hub/workflow",
      providerImportAliases: {
        "@vite-hub/kv/runtime/redis-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-redis-driver\.(?:ts|js)$/),
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-upstash-driver\.(?:ts|js)$/),
      },
      includeUserAppEntry: true,
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
      workspaceRuntimeModule: "/agent/dist/internal/workspace/runtime.js",
    })
    expect(integrationMocks.hubWorkflow).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    vitehub({ agent: true, host: "node" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      runtimeCapabilityImports: expect.objectContaining({ console: false, db: false }),
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      implicitlyEnabled: true,
      includeUserAppEntry: false,
    }))
    vitehub({ agent: true, console: { auth: false }, host: "node" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      runtimeCapabilityImports: expect.objectContaining({ console: "vite-hub/console/server" }),
    }))
    expect(integrationMocks.hubWorkspace).toHaveBeenLastCalledWith({
      hosting: "node-server",
    })

    vitehub({ agent: true, console: { auth: false }, host: "node" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      runtimeCapabilityImports: expect.objectContaining({ console: "vite-hub/console/server" }),
    }))

    vitehub({
      agent: { imports: false },
      database: { cli: { generate: false } },
      host: "node",
      workflow: { provider: "vercel" },
      workspace: { root: ".data/workspaces" },
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({ imports: false }))
    expect(integrationMocks.hubDb).toHaveBeenLastCalledWith({ cli: { generate: false } })
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "vercel" }),
      expect.any(Object),
    )
    expect(integrationMocks.hubWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ root: ".data/workspaces" }))

    integrationMocks.hubQueue.mockClear()
    expect(pluginNames(vitehub({ host: "vercel", queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "vercel" }, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    expect(pluginNames(vitehub({ host: "cloudflare", queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "cloudflare" }, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    vitehub({ host: "cloudflare", queue: { cache: true, binding: "JOBS" } })
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ binding: "JOBS", cache: true, provider: "cloudflare" }, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    // Node leaves the provider to Queue, which picks `postgres` with a Postgres Default Database, else `local`.
    expect(pluginNames(vitehub({ host: "node", queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({}, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    vitehub({ host: "node", queue: { cache: false } })
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ cache: false }, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    vitehub({ host: "node", queue: { provider: "postgres" } })
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({ provider: "postgres" }, { databaseImport: "vite-hub/database/drizzle", importBase: "vite-hub/queue" })
    expect(() => vitehub({ host: "vercel", queue: { provider: "postgres" } })).toThrow("works with the \"node\" host only")

    integrationMocks.hubRateLimit.mockClear()
    expect(pluginNames(vitehub({ host: "node", rateLimit: true }))).toContain("@vite-hub/rate-limit/vite")
    expect(integrationMocks.hubRateLimit).toHaveBeenLastCalledWith({
      provider: "memory",
    })
    expect(pluginNames(vitehub({ host: "cloudflare", rateLimit: true }))).toContain("@vite-hub/rate-limit/vite")
    expect(integrationMocks.hubRateLimit).toHaveBeenLastCalledWith({
      provider: "cloudflare",
    })
    expect(pluginNames(vitehub({
      host: "cloudflare",
      rateLimit: { projectRoot: "packages/policies", scanDirs: ["rules"] },
    }))).toContain("@vite-hub/rate-limit/vite")
    expect(integrationMocks.hubRateLimit).toHaveBeenLastCalledWith({
      projectRoot: "packages/policies",
      provider: "cloudflare",
      scanDirs: ["rules"],
    })
  })

  it("checks Forms entries when only the Forms owner is absent", () => {
    expect(ownerModules.commentsVite).toBeDefined()
    expect(ownerModules.contentVite).toBeDefined()
    expect(ownerModules.cmsVite).toBeDefined()
    const forms = ownerModules.formsVite
    try {
      ownerModules.formsVite = undefined
      expect(pluginNames(vitehub({ database: false, host: "node" }))).toContain("vite-hub/optional-owner-entries")
    }
    finally {
      ownerModules.formsVite = forms
    }
  })

  it("keeps the request error logger when evlog is disabled", () => {
    expect(pluginNames(vitehub({ host: "node", observability: { service: "support", evlog: { enabled: false } } })))
      .toContain("vite-hub/error-log")
    expect(pluginNames(vitehub({ host: "node", observability: { service: "support" } })))
      .not.toContain("vite-hub/error-log")
  })

  it("checks the Database packages of Connections as the connections feature", () => {
    vitehub({ host: "node", connections: true })
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(["connections"])
  })

  it("checks the MCP SDK only when the Console MCP client is on", () => {
    vitehub({ host: "node", console: { auth: false } })
    expect(vi.mocked(assertFeaturePackages).mock.lastCall?.[0]).not.toContain("console mcp-client")
    vitehub({ host: "node", console: { auth: false, mcpClient: true } })
    expect(vi.mocked(assertFeaturePackages).mock.lastCall?.[0]).toContain("console mcp-client")
  })

  it.each([
    [{ blob: true }, ["blob"]],
    [{ host: "cloudflare", browser: true }, ["browser"]],
    [{ channels: true }, ["channels"]],
    [{ email: { driver: "resend" } }, ["email"]],
    [{ kv: true }, ["kv"]],
    [{ cache: { driver: "kv" } }, ["kv"]],
    [{ queue: true }, ["queue"]],
    [{ rateLimit: true }, ["rateLimit"]],
    [{ host: "cloudflare", sandboxTask: true }, ["sandboxTask"]],
    [{ workflow: true }, ["workflow"]],
    // Agents run on Workflow.
    [{ agent: true }, ["agent", "workflow"]],
    [{ agent: true, workflow: false }, ["agent"]],
    [{ host: "netlify", agent: { invocations: false } }, ["agent"]],
    [{ host: "netlify", agent: { invocations: false }, workflow: false }, ["agent"]],
    [{ host: "netlify", agent: { invocations: false }, workflow: true }, ["agent", "workflow"]],
    [{ host: "netlify", agent: { invocations: false }, workflow: {} }, ["agent", "workflow"]],
  ] as const)("checks the owner packages of %j", (options, features) => {
    vitehub({ host: "node", ...options } as ViteHubOptions)
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(features)
  })

  it.each([undefined, false] as const)("keeps Netlify Agents inline without the Workflow peer (%s)", (workflow) => {
    vi.mocked(assertFeaturePackages).withImplementation(features => {
      if (features.includes("workflow")) throw missingFeaturePackagesError(["workflow"])
    }, () => {
      const workflowCallsBefore = integrationMocks.hubWorkflow.mock.calls.length
      expect(pluginNames(vitehub({ host: "netlify", agent: { invocations: false }, workflow })))
        .not.toContain("@vite-hub/workflow/vite")
      expect(integrationMocks.hubWorkflow).toHaveBeenCalledTimes(workflowCallsBefore)
      expect(assertFeaturePackages).toHaveBeenLastCalledWith(["agent"])
    })
  })

  it("checks no owner package without features", () => {
    vitehub({ host: "node" })
    expect(assertFeaturePackages).toHaveBeenLastCalledWith([])
  })

  it("requires the Agent package for observability without Agents", () => {
    vitehub({ host: "node", observability: { service: "support" } })
    expect(assertFeaturePackages).toHaveBeenLastCalledWith(["agent"])
  })

  it.each([undefined, false] as const)("keeps Workspace-only Workflow imports independent of Agent (%s)", (agent) => {
    vi.mocked(isPackageInstalled).withImplementation(name => name !== "@vite-hub/shell", () => {
      const agentCallsBefore = integrationMocks.hubAgent.mock.calls.length
      vitehub({ agent, host: "node", workflow: true, workspace: true })
      expect(integrationMocks.hubAgent).toHaveBeenCalledTimes(agentCallsBefore)
      expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
        workspaceDependencyRuntimeImports: {},
        workspaceRuntimeModule: "vite-hub/workspace/runtime",
      }))
    })
  })

  it("omits the Workspace Shell loader when the Shell package is absent", () => {
    vi.mocked(isPackageInstalled).withImplementation(name => name !== "@vite-hub/shell", () => {
      vitehub({ host: "node", agent: true })
      expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
        workspaceDependencyRuntimeImports: {},
      }))
    })
  })

  it("keeps the Workspace Shell loader only when the app installs the Shell package", async () => {
    // vite-hub resolves its own development dependencies here, so only the app root can tell the two apps apart.
    const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-shell-"))
    try {
      for (const installed of [false, true]) {
        const appRoot = join(root, installed ? "with-shell" : "without-shell")
        await mkdir(appRoot, { recursive: true })
        await writeFile(join(appRoot, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }))
        if (installed) {
          const shellRoot = join(appRoot, "node_modules/@vite-hub/shell")
          await mkdir(shellRoot, { recursive: true })
          await writeFile(join(shellRoot, "package.json"), JSON.stringify({ name: "@vite-hub/shell", exports: { "./package.json": "./package.json" } }))
        }

        const shellPlugin = (vitehub({ host: "cloudflare", agent: true }).flat() as Plugin[]).find(plugin => plugin.name === "vite-hub/workspace-shell")
        if (shellPlugin) await callHook(shellPlugin.config, [{ root: appRoot }, { command: "build", mode: "production" }])

        expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
          workspaceDependencyRuntimeImports: installed ? { shellWorkspace: "vite-hub/shell/workspace" } : {},
        }))
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("passes configured Email drivers through the canonical integration", () => {
    const email = {
      driver: "resend" as const,
      options: { endpoint: "https://api.resend.com" },
    }

    vitehub({ email, host: "node" })

    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      ...email,
      hosting: "node-server",
      runtimeEnvImport: expect.stringMatching(/[\\/]env[\\/]dist[\\/]internal[\\/]server\.js$/),
      workflowProvider: undefined,
    })

    vitehub({ email, host: "node", workflow: { provider: "vercel" } })
    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith(expect.objectContaining({ workflowProvider: "vercel" }))
  })

  it("uses Cloudflare Email when Email is enabled by preset", () => {
    vitehub({ email: true, host: "cloudflare" })

    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      driver: "cloudflare-email",
      hosting: "cloudflare-module",
      runtimeEnvImport: expect.stringMatching(/[\\/]env[\\/]dist[\\/]internal[\\/]server\.js$/),
      workflowProvider: undefined,
    })
  })

  it("rejects the Cloudflare Email default on other presets", () => {
    expect(() => vitehub({ email: true, host: "node" })).toThrow("requires the Cloudflare host")
  })

  it("treats auth: false and email: false as omitted", () => {
    integrationMocks.hubAuth.mockClear()
    integrationMocks.hubEmail.mockClear()

    expect(pluginNames(vitehub({ auth: false, email: false, host: "node" }))).toEqual(pluginNames(vitehub({ host: "node" })))
    expect(integrationMocks.hubAuth).not.toHaveBeenCalled()
    expect(integrationMocks.hubEmail).not.toHaveBeenCalled()
  })

  it("passes the active host to Workflow inference", () => {
    vitehub({ host: "cloudflare", schedule: true, workflow: true })

    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith(expect.not.objectContaining({
      providerOutput: expect.anything(),
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "cloudflare-module",
    }))

    vitehub({ host: "vercel", schedule: true, workflow: true })

    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOutput: "standalone",
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "vercel",
    }))

    vitehub({ host: "netlify", schedule: true, workflow: true })

    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "netlify",
    }))
  })

  it("uses the Env owner runtime path in generated Env modules", () => {
    vitehub({ host: "node" })

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      runtimeImports: {
        secret: "vite-hub/env",
        server: expect.stringMatching(/[\\/]env[\\/]dist[\\/]internal[\\/]server\.js$/),
      },
    })

    vitehub({
      host: "node",
      env: {
        diagnostics: "trace",
        runtimeImports: { server: "#app/env/server" },
      },
    })

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      diagnostics: "trace",
      runtimeImports: {
        secret: "vite-hub/env",
        server: "#app/env/server",
      },
    })
  })

  it("keeps Sandbox loaders aligned with preset enablement", () => {
    vitehub({ agent: true, host: "cloudflare", sandboxTask: true, workflow: true })

    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        sandboxTask: "vite-hub/sandbox/task",
        sandboxTaskRuntimeState: "/sandbox/dist/task/runtime/state.js",
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        sandboxTask: "vite-hub/sandbox/task",
        sandboxTaskRuntimeState: "/sandbox/dist/task/runtime/state.js",
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))

    vitehub({ agent: true, host: "node", workflow: true })

    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
  })

  it("preserves runtime-aware Agent State selection for Cloudflare builds", () => {
    vitehub({ agent: true, host: "cloudflare" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.not.objectContaining({
      providers: expect.anything(),
    }))

    vitehub({
      agent: { providers: { state: { driver: "libsql", url: "libsql://state.example.test" } } },
      host: "cloudflare",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: { state: { driver: "libsql", url: "libsql://state.example.test" } },
    }))

    vitehub({
      agent: { providers: { state: { url: "libsql://state.example.test" } } },
      host: "cloudflare",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: { state: { url: "libsql://state.example.test" } },
    }))

  })

  it("resolves only package-owned imports from generated modules", async () => {
    const resolveId = dependencyResolver()

    expect(await resolveId.call(pluginContext, "vite-hub/auth/server", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/agent", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/agent", "\0virtual:third-party", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/agent", "/app/.vitehub-other/agent.ts", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/agent", "\0#vitehub/custom", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/workspace/runtime", "\0#vitehub-workspace-registry", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@chat-adapter/discord", "/app/.vitehub/agent/route.ts", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(pluginContext, "@vite-hub/agent/server", "/app/.vitehub/agent/route.ts", pluginResolveOptions))
      .toMatch(/\/agent\/dist\/server\.js$/)
    expect(await resolveId.call(pluginContext, "@vite-hub/agent/server", "C:\\app\\.vitehub\\agent\\route.ts", pluginResolveOptions))
      .toMatch(/\/agent\/dist\/server\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "@vite-hub/auth/server",
      "\0#vitehub/auth/server",
      pluginResolveOptions,
    )).toMatch(/\/auth\/dist\/server\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "@vite-hub/env/internal/server",
      "\0#vitehub/env/server",
      pluginResolveOptions,
    )).toMatch(/\/env\/dist\/internal\/server\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "@vite-hub/schedule/runtime",
      "\0#vitehub/schedule/registry",
      pluginResolveOptions,
    )).toMatch(/\/schedule\/dist\/runtime\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "@vite-hub/agent/cloudflare/state",
      "\0virtual:vitehub-agent-cloudflare-state-exports",
      pluginResolveOptions,
    )).toMatch(/\/agent\/dist\/cloudflare\/state\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "vite-hub/auth/server",
      "\0#vitehub/auth/server",
      pluginResolveOptions,
    )).toMatch(/\/vite-hub\/dist\/auth\/server\.js$/)
    expect(await resolveId.call(
      pluginContext,
      "vite-hub/blob",
      "/app/.vitehub/nitro/blob/plugin.ts",
      pluginResolveOptions,
    )).toMatch(/\/vite-hub\/dist\/blob\.js$/)
  })

  it("resolves generated Nitro and H3 imports from the app, then from vite-hub's Nitro", async () => {
    const resolveId = dependencyResolver()
    const resolve = vi.fn(async (id: string, importer: string) => {
      if (/[\\/]nitro[\\/]package\.json$/.test(importer)) return { id: `/nitro/node_modules/${id}/dist/index.mjs` }
      if (/[\\/]vite-hub[\\/]package\.json$/.test(importer)) return { id: `/vite-hub/node_modules/${id}/dist/index.mjs` }
      return null
    })
    const context = { resolve } as never
    const importer = "/app/.vitehub/agent/chat-webhook-route.ts"

    expect(await resolveId.call(context, "h3", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
    expect(await resolveId.call(context, "nitro", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    expect(await resolveId.call(context, "h3", importer, pluginResolveOptions)).toEqual({ id: "/nitro/node_modules/h3/dist/index.mjs" })
    expect(resolve).toHaveBeenNthCalledWith(1, "h3", importer, { skipSelf: true })
    expect(await resolveId.call(context, "nitro/cache", importer, pluginResolveOptions))
      .toEqual({ id: "/vite-hub/node_modules/nitro/cache/dist/index.mjs" })
    expect(await resolveId.call(context, "nitropack", importer, pluginResolveOptions)).toBeUndefined()

    resolve.mockResolvedValueOnce({ id: "/app/node_modules/h3/dist/index.mjs" })
    expect(await resolveId.call(context, "h3", importer, pluginResolveOptions)).toEqual({ id: "/app/node_modules/h3/dist/index.mjs" })
  })

  it("resolves provider facades after framework aliasing", async () => {
    const plugin = dependencyPlugin({ host: "vercel", sandboxTask: true })
    const frameworkSandboxTaskFacade = pluginAliases(plugin)["vite-hub/sandbox/task"]
    const sandboxTaskAliases = providerAliasesFromCall(integrationMocks.hubSandboxTask.mock.calls.at(-1))
    const providerSandboxTaskFacade = "/app/.vitehub/sandbox-task/provider.mjs"

    sandboxTaskAliases["@vite-hub/sandbox/task"] = providerSandboxTaskFacade
    sandboxTaskAliases["vite-hub/sandbox/task"] = providerSandboxTaskFacade

    const resolveId = filteredResolveId(plugin)
    expect(await resolveId.call(pluginContext, "vite-hub/sandbox/task", "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxTaskFacade)
    expect(await resolveId.call(pluginContext, "@vite-hub/sandbox/task", "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxTaskFacade)
    expect(await resolveId.call(pluginContext, frameworkSandboxTaskFacade, "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxTaskFacade)
    expect(await resolveId.call(pluginContext, "@vite-hub/kv/runtime/upstash-driver", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
  })

  it("skips relative, virtual, and app file ids before the dependency resolver runs", () => {
    const plugin = dependencyPlugin()
    const frameworkKVFacade = pluginAliases(plugin)["vite-hub/kv"]
    expect(matchesIdFilter(plugin.resolveId, "./server.ts")).toBe(false)
    expect(matchesIdFilter(plugin.resolveId, "\0virtual:vitehub-agent-cloudflare-state-exports")).toBe(false)
    expect(matchesIdFilter(plugin.resolveId, "/app/server/api.ts")).toBe(false)
    expect(matchesIdFilter(plugin.resolveId, "#vitehub/env/server")).toBe(true)
    expect(matchesIdFilter(plugin.resolveId, "nitro/app")).toBe(true)
    expect(matchesIdFilter(plugin.resolveId, frameworkKVFacade)).toBe(true)
  })

  it.each(generatedOwnerPackageCases)("classifies generated import %s as %s", async (name, access) => {
    // Owner packages such as @vite-hub/presets export only subpaths, so import the first public entry.
    const specifier = ownerPackageImportSpecifier(name)
    // SAFETY: This resolver does not read the Vite plugin context or resolve options in these cases.
    const resolved = await dependencyResolver().call(pluginContext, specifier, "\0#vitehub/env/server", pluginResolveOptions)
    if (access === "deny") expect(resolved).toBeUndefined()
    else expect(resolved).toBe(fileURLToPath(import.meta.resolve(specifier)))
  })

  it("keeps third-party driver fallbacks out of the global alias map", async () => {
    const plugin = dependencyPlugin()
    const aliases = pluginAliases(plugin)

    expect(aliases).not.toHaveProperty("vite-hub")
    expect(aliases).not.toHaveProperty("unstorage/drivers/upstash")
    expect(aliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    expect(Object.keys(aliases).filter(specifier => specifier.startsWith("vite-hub/_internal"))).toEqual([])
    expect(aliases["vite-hub/shell/workspace"]).toMatch(/packages\/vite-hub\/dist\/shell\/workspace\.js$/)
  })

  it("aliases non-JavaScript exports, such as vite-hub/ui/styles.css, on their own", () => {
    const aliases = pluginAliases(dependencyPlugin())

    expect(aliases["vite-hub/ui/styles.css"]).toMatch(/packages\/vite-hub\/dist\/ui\/styles\.css$/)
    expect(aliases["vite-hub/ui"]).toMatch(/packages\/vite-hub\/dist\/ui\.js$/)
  })

  it("matches each facade alone, so a subpath the package doesn't export isn't rewritten into a facade's file", () => {
    const entries = pluginAliasEntries(dependencyPlugin())
    const matching = (id: string) => entries.filter(({ find }) => find.test(id)).map(({ replacement }) => replacement)

    expect(matching("vite-hub/realtime")).toEqual([expect.stringMatching(/packages\/vite-hub\/dist\/realtime\.js$/)])
    expect(matching("vite-hub/realtime/client")).toEqual([expect.stringMatching(/packages\/vite-hub\/dist\/realtime\/client\.js$/)])
    expect(matching("vite-hub/realtime/nope")).toEqual([])
    expect(matching("vite-hub/ui/styles.css")).toEqual([expect.stringMatching(/packages\/vite-hub\/dist\/ui\/styles\.css$/)])
  })

  it("leaves facades of an absent owner package unaliased so their import names the package to install", () => {
    vi.mocked(isPackageInstalled).withImplementation(name => name !== "@vite-hub/ui", () => {
      const aliases = pluginAliases(dependencyPlugin())
      expect(Object.keys(aliases).filter(specifier => /^vite-hub\/ui(?:\/|$)/.test(specifier))).toEqual([])
      expect(aliases["vite-hub/shell"]).toMatch(/packages\/vite-hub\/dist\/shell\.js$/)
    })
    const imports = dependencyPluginByName(vitehub({ host: "node" }), "vite-hub/optional-owner-imports")
    vi.mocked(assertFeaturePackages).mockClear()
    callHook(imports.resolveId, ["vite-hub/ui/headless", "/app/app.vue"])
    expect(assertFeaturePackages).toHaveBeenCalledExactlyOnceWith(["ui"])
  })

  it("looks up the packages of the owner facades one time when Nuxt and Vite both run the config hook", () => {
    const plugin = dependencyPlugin()
    pluginAliases(plugin)
    const lookups: string[] = []
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        lookups.push(specifier)
        return nextResolve(specifier, context)
      },
    })
    try {
      pluginAliases(plugin)
    }
    finally {
      hooks.deregister()
    }
    expect(lookups).toEqual([])
  })

  it("starts new package checks each time Vite loads the app config", () => {
    vi.mocked(startPackageChecks).mockClear()
    vitehub({ host: "node" })
    expect(startPackageChecks).toHaveBeenCalledOnce()
  })

  it("forgets the package checks when Vite closes the plugins", () => {
    vi.mocked(forgetPackageChecks).mockClear()
    callHook(dependencyPlugin().closeBundle, [])
    expect(forgetPackageChecks).toHaveBeenCalledOnce()
  })

  it("passes the unused Upstash and Redis fallbacks only to provider bundlers", () => {
    vitehub({ agent: true, host: "node", workflow: true })
    const defaultAliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    expect(defaultAliases).toEqual({
      "@vite-hub/kv/runtime/redis-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-redis-driver\.(?:ts|js)$/),
      "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/(?:src|dist)\/internal\/disabled-upstash-driver\.(?:ts|js)$/),
    })

    // Inferred Node stores keep their build-selected driver; Redis is explicit.
    vitehub({ agent: true, host: "node", kv: { driver: "redis" } })
    expect(providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))).not.toHaveProperty("@vite-hub/kv/runtime/redis-driver")

    const upstashPlugins = vitehub({ agent: true, host: "node", kv: { driver: "upstash" }, workflow: true })
    const upstashAliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    // SAFETY: The dependency plugin is part of every vitehub() result.
    const dependency = upstashPlugins.find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin
    callHook(dependency.configResolved, [{}])

    expect(upstashAliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    expect(upstashAliases["@vite-hub/kv/runtime/redis-driver"]).toMatch(/disabled-redis-driver\.(?:ts|js)$/)
    expect(providerAliasesFromCall(integrationMocks.hubWorkflow.mock.calls.at(-1), 1)).toBe(upstashAliases)
  })

  it("exposes owner package aliases to deferred provider bundlers", async () => {
    const aliases = await providerOutputAliases(dependencyPlugin({ agent: true, host: "vercel", schedule: true, workflow: true }))

    expect(aliases["@vite-hub/agent"]).toMatch(/packages\/agent\/dist\/index\.js$/)
    expect(aliases["@vite-hub/agent/server/internal"]).toMatch(/packages\/agent\/dist\/server\/internal\.js$/)
    expect(aliases["@vite-hub/markdown-template"]).toMatch(/packages\/markdown-template\/dist\/index\.js$/)
    expect(aliases["@vite-hub/workflow/runtime/state"]).toMatch(/packages\/workflow\/dist\/runtime\/state\.js$/)
  })

  it("retains generated Server Env for deferred provider bundles", () => {
    const plugins = vitehub({ agent: true, host: "node" })
    const aliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    const dependency = plugins.find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin

    callHook(dependency.configResolved, [{ root: "/app" }])

    expect(aliases["#vitehub/env/server"]).toBe("/app/.vitehub/env/server.mjs")
    expect(aliases["#vitehub/env/description"]).toBe("/app/.vitehub/env/description.mjs")
  })

  it("retains generated Server Env from the resolved Env project root", () => {
    const plugins = vitehub({ agent: true, env: { projectRoot: ".." }, host: "node" })
    const aliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    const dependency = plugins.find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin

    callHook(dependency.configResolved, [{ root: "/app/client" }])

    expect(aliases["#vitehub/env/server"]).toBe("/app/.vitehub/env/server.mjs")
    expect(aliases["#vitehub/env/description"]).toBe("/app/.vitehub/env/description.mjs")
  })

  it.each([
    ["cloudflare", "cloudflare-module"],
    ["netlify", "netlify"],
    ["vercel", "vercel"],
    ["deno", "deno-server"],
    ["node", "node-server"],
  ] as const)("maps the %s deployment plan to Nitro %s", async (preset, nitroPreset) => {
    const config: Record<string, unknown> = preset === "deno"
      ? { nitro: { rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } } } }
      : {}
    const plugin = dependencyPluginByName(vitehub({ host: preset }), "vite-hub/deployment-host")
    await callHook(plugin.config, [config, { command: "build", mode: "production" }])
    expect(config.nitro).toMatchObject({ preset: nitroPreset })
    if (preset === "cloudflare") {
      expect(config.nitro).toMatchObject({ wasm: { lazy: true } })
    }
    else {
      expect(config.nitro).not.toHaveProperty("wasm")
    }
    if (preset === "deno") {
      expect(config.nitro).toMatchObject({
        commands: { deploy: "node ./deploy.mjs" },
        modules: [expect.any(Function)],
        rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs", entryFileNames: "index.mjs" } },
      })
    }
  })

  it.each([
    ["deno", false, "deno-server"],
    ["cloudflare", true, "cloudflare-module"],
  ] as const)("selects the %s preset with realtime %s during Nuxt config replay", async (preset, realtime, nitroPreset) => {
    const plugins = vitehub({ cache: { driver: "kv" }, kv: true, host: preset, realtime })
    const settings = dependencyPluginByName(plugins, "vite-hub/deployment-settings")
    const deployment = dependencyPluginByName(plugins, "vite-hub/deployment-host")
    const output = dependencyPluginByName(plugins, "vite-hub/deployment-output")
    try {
      vi.stubEnv("NITRO_PRESET", nitroPreset)
      vi.stubEnv("SERVER_PRESET", nitroPreset)
      for (const initialPreset of [undefined, nitroPreset]) {
        const config = {
          [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
          command: "build",
          nitro: { preset: initialPreset },
        }
        await callHook(settings.config, [config, { command: "build", mode: "production" }])
        expect(config.nitro.preset).toBe(nitroPreset)
        await callHook(deployment.config, [config, { command: "build", mode: "production" }])
        expect(config.nitro.preset).toBe(nitroPreset)
        expect(config.nitro).toHaveProperty("kv.cache.driver", kvCacheDriver)
        expect(config.nitro).toHaveProperty("$development.kv.cache.driver", kvCacheDriver)
        expect(() => callHook(output.configResolved, [config])).not.toThrow()
      }
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ["cloudflare", { binding: "CACHE", driver: "cloudflare-kv-binding" }],
    ["vercel", { driver: "vercel-runtime-cache" }],
    ["deno", { base: "cache", driver: "deno-kv" }],
    ["node", { base: ".vitehub/data/cache", driver: "fs-lite" }],
  ] as const)("mounts Nitro cache storage for the %s preset", async (preset, storage) => {
    const config = await applyDeploymentConfig(
      { cache: preset === "cloudflare" ? { driver: "cloudflare-kv-binding", namespaceId: "cache-id" } : true, host: preset },
    )

    expect(config.nitro).toMatchObject({
      $development: { kv: { cache: { base: ".vitehub/data/cache", driver: "fs-lite" } } },
      kv: { cache: storage },
    })
    if (preset === "cloudflare") {
      expect(config.nitro).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "CACHE", id: "cache-id" }])
    }
  })

  it("keeps an application cache mount and other KV namespaces", async () => {
    const config = await applyDeploymentConfig(
      { cache: true, host: "cloudflare" },
      { nitro: { cloudflare: { wrangler: { kv_namespaces: [{ binding: "KV", id: "kv-id" }] } }, kv: { cache: { driver: "memory" } } } },
    )

    expect(config.nitro).toHaveProperty("kv.cache", { driver: "memory" })
    expect(config.nitro).toHaveProperty("cloudflare.wrangler.kv_namespaces", [{ binding: "KV", id: "kv-id" }])
  })

  it("mounts Nitro cache storage on the app's KV store", async () => {
    const config = await applyDeploymentConfig({ cache: { driver: "kv" }, kv: true, host: "cloudflare" })
    const mount = { base: "nitro-cache", driver: kvCacheDriver }

    expect(config.nitro).toMatchObject({ $development: { kv: { cache: mount } }, kv: { cache: mount } })
    await expect(applyDeploymentConfig({ cache: { driver: "kv" }, host: "cloudflare" })).rejects.toThrow("`kv` is not enabled")
  })

  it.each(["build", "serve"] as const)("validates the effective KV cache configuration during %s", async (command) => {
    const options = { cache: { driver: "kv" as const }, host: "node" as const }
    await expect(applyDeploymentConfig({ ...options, kv: false }, {}, command)).rejects.toThrow("`kv` is not enabled")
    await expect(applyDeploymentConfig({ ...options, kv: { driver: "fs-lite" } }, {}, command)).resolves.toHaveProperty(
      "nitro.kv.cache.driver", kvCacheDriver,
    )
  })

  it("stores the Node cache under dataDir", async () => {
    const config = await applyDeploymentConfig({ cache: true, dataDir: "/tmp/vitehub-data", host: "node" })

    expect(config.nitro).toMatchObject({
      $development: { kv: { cache: { base: "/tmp/vitehub-data/cache", driver: "fs-lite" } } },
      kv: { cache: { base: "/tmp/vitehub-data/cache", driver: "fs-lite" } },
    })
  })

  it("rejects a cache store that the host cannot provide", async () => {
    await expect(applyDeploymentConfig({ cache: true, host: "netlify" })).rejects.toThrow("`cache: true` has no default store for the netlify host.")
    await expect(applyDeploymentConfig({ cache: { driver: "fs-lite" }, host: "cloudflare" })).rejects.toThrow("`cache.driver: \"fs-lite\"` requires the node host, but the host is cloudflare.")
  })

  it("preserves an explicit Cloudflare WASM loading mode", async () => {
    const config = await applyDeploymentConfig(
      { host: "cloudflare" },
      { nitro: { wasm: { lazy: false } } },
    )

    expect(config.nitro).toMatchObject({ wasm: { lazy: false } })
  })

  it("uses Nitro's Durable Object transport for Cloudflare realtime", async () => {
    const config = await applyDeploymentConfig({ host: "cloudflare", realtime: true })

    expect(config.nitro).toMatchObject({
      preset: "cloudflare-module",
      cloudflare: {
        wrangler: {
          durable_objects: {
            bindings: [{ class_name: "$DurableObject", name: "$DurableObject" }],
          },
          migrations: [{ new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" }],
        },
      },
    })
  })

  async function cloudflareCommands(
    options: Parameters<typeof vitehub>[0],
    config: Record<string, unknown>,
    serverDir = "/app/.output/server",
    rootDir = "/app",
  ) {
    const plugins = vitehub(options)
    const preset = dependencyPluginByName(plugins, "vite-hub/deployment-host")
    const output = dependencyPluginByName(plugins, "vite-hub/deployment-output")
    await callHook(preset.config, [config, { command: "build", mode: "production" }])
    // SAFETY: The preset config hook populated Nitro commands and modules above.
    const nitroConfig = config.nitro as { cloudflare?: { deployConfig?: boolean }, commands?: Record<string, unknown>, modules: unknown[] }
    callHook(output.configResolved, [{ command: "build", nitro: nitroConfig }])
    // Nitro applies the cloudflare-module preset defaults before modules run.
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        cloudflare: nitroConfig.cloudflare,
        commands: { deploy: "npx wrangler --cwd ./ deploy", preview: "npx wrangler --cwd ./ dev", ...nitroConfig.commands },
        output: { dir: join(rootDir, ".output"), serverDir },
        preset: "cloudflare_module",
        rootDir,
      },
    }
    // SAFETY: The deployment host plugin prepends its Nitro module to the module list.
    const module = nitroConfig.modules[0] as (target: typeof nitro) => void
    module(nitro)
    return { commands: nitro.options.commands, modules: nitroConfig.modules, nitro }
  }

  it.each([undefined, true])("deploys Cloudflare builds with the generated Wrangler config when deployConfig is %s", async deployConfig => {
    const { commands } = await cloudflareCommands(
      { host: "cloudflare" },
      { nitro: { cloudflare: { deployConfig } } },
    )

    expect(commands).toEqual({
      deploy: "npx wrangler deploy --config ./server/wrangler.json",
      preview: "npx wrangler --cwd ./ dev",
    })
  })

  it.each([false, true])("preserves Nitro's Cloudflare deploy command when deployConfig is disabled and Sandbox is %s", async sandboxTask => {
    const { commands } = await cloudflareCommands(
      { host: "cloudflare", sandboxTask },
      { nitro: { cloudflare: { deployConfig: false } } },
    )

    expect(commands).toEqual({
      deploy: "npx wrangler --cwd ./ deploy",
      preview: "npx wrangler --cwd ./ dev",
    })
  })

  it.each(["server", "cloudflare worker", "worker's directory"])("rebases the Cloudflare config in %s for prebuilt deployment", async serverDir => {
    const { commands } = await cloudflareCommands(
      { host: "cloudflare", sandboxTask: true },
      {},
      `/app/.output/${serverDir}`,
    )
    // Apply Nitro's deploy --prebuilt rewrite, then check the arguments Wrangler receives from the shell.
    const command = commands.deploy.replace(/([\s:])\.\/(\S*)/g, "$1.output/$2")
    const result = spawnSync("sh", ["-c", 'npx() { printf "%s\\n" "$@"; }\n' + command], { encoding: "utf8" })

    expect(result.status).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual([
      "wrangler", "deploy", "--config", `.output/${serverDir}/wrangler.json`, "--containers-rollout=gradual",
    ])
  })

  it.each([".env", "config/prod secrets.env"])("uploads the Cloudflare secrets file %s through the prebuilt deploy command", async secretsFile => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-secrets-file-"))
    try {
      await mkdir(join(root, "config"))
      await writeFile(join(root, secretsFile), "API_TOKEN=secret\n")
      const { commands } = await cloudflareCommands(
        { cloudflare: { secretsFile }, host: "cloudflare", sandboxTask: true },
        {},
        join(root, ".output/server"),
        root,
      )
      // Apply Nitro's deploy --prebuilt rewrite, then run the command from the project root as Nitro does.
      const command = commands.deploy.replace(/([\s:])\.\/(\S*)/g, "$1.output/$2")
      const result = spawnSync("sh", ["-c", 'npx() { printf "%s\\n" "$@"; }\n' + command], { cwd: root, encoding: "utf8" })

      expect(result.status).toBe(0)
      expect(result.stdout.trim().split("\n")).toEqual([
        "wrangler", "deploy", "--config", ".output/server/wrangler.json", "--secrets-file", `.output/../${secretsFile}`, "--containers-rollout=gradual",
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("leaves the secrets file out of the Cloudflare deploy command when the file is missing at build time", async () => {
    const { commands } = await cloudflareCommands(
      { cloudflare: { secretsFile: ".env" }, host: "cloudflare" },
      {},
    )

    expect(commands.deploy).toBe("npx wrangler deploy --config ./server/wrangler.json")
  })

  it("deploys Cloudflare Sandbox containers through the generated Nitro command", async () => {
    const userModule = (nitro: { options: { commands: Record<string, unknown> } }) => {
      nitro.options.commands.deploy = "node ./deploy.mjs"
    }
    const { commands, modules, nitro } = await cloudflareCommands(
      { host: "cloudflare", sandboxTask: true },
      { nitro: { commands: { preview: "node ./preview.mjs" }, modules: [userModule] } },
      "/app/.output/cloudflare worker",
    )

    expect(commands).toEqual({
      deploy: "npx wrangler deploy --config ./'cloudflare worker/wrangler.json' --containers-rollout=gradual",
      preview: "node ./preview.mjs",
    })
    expect(modules[1]).toBe(userModule)
    userModule(nitro)
    expect(commands.deploy).toBe("node ./deploy.mjs")
  })

  it("preserves an explicit Cloudflare deploy command", async () => {
    const { commands } = await cloudflareCommands(
      { host: "cloudflare", sandboxTask: true },
      { nitro: { commands: { deploy: "node ./deploy.mjs" } } },
    )

    expect(commands).toEqual({
      deploy: "node ./deploy.mjs",
      preview: "npx wrangler --cwd ./ dev",
    })
  })

  it("aliases Cloudflare runtime imports during Nitro prerendering", async () => {
    const existingPrerender = vi.fn()
    const config = await applyDeploymentConfig(
      { host: "cloudflare" },
      { nitro: { hooks: { "prerender:config": existingPrerender } } },
    )
    // SAFETY: applyDeploymentConfig preserves and returns the configured Nitro hook record.
    const hooks = (config.nitro as { hooks: Record<string, unknown> }).hooks
    // SAFETY: The fixture installs this exact async prerender hook.
    const prerender = hooks["prerender:config"] as (config: Record<string, unknown>) => Promise<void>
    const prerenderConfig = {
      alias: { existing: "/existing" },
      rollupConfig: { external: ["cloudflare:workers", "node:fs"] },
    }

    await prerender(prerenderConfig)

    expect(existingPrerender).toHaveBeenCalledWith(prerenderConfig)
    expect(prerenderConfig).toMatchObject({
      alias: {
        "cloudflare:email": expect.stringMatching(/cloudflare-prerender\.mjs$/),
        "cloudflare:workers": expect.stringMatching(/cloudflare-prerender\.mjs$/),
        existing: "/existing",
      },
    })
    const external = Reflect.get(prerenderConfig.rollupConfig, "external")
    if (!isCallable(external)) throw new TypeError("Expected the prerender external predicate.")
    expect(external("cloudflare:workers")).toBe(false)
    expect(external("node:fs")).toBe(true)
  })

  it("aliases every Cloudflare Email runtime import during Nitro prerendering", async () => {
    const config = await applyDeploymentConfig({ host: "cloudflare" })
    // SAFETY: applyDeploymentConfig installs the Cloudflare prerender hook record.
    const hooks = (config.nitro as { hooks: Record<string, unknown> }).hooks
    // SAFETY: The deployment plugin installs this exact async prerender hook.
    const prerender = hooks["prerender:config"] as (config: Record<string, unknown>) => Promise<void>
    const prerenderConfig = {
      rollupConfig: { external: ["cloudflare:email", "cloudflare:workers"] },
    }

    await prerender(prerenderConfig)

    expect(prerenderConfig).toMatchObject({
      alias: {
        "cloudflare:email": expect.stringMatching(/cloudflare-prerender\.mjs$/),
        "cloudflare:workers": expect.stringMatching(/cloudflare-prerender\.mjs$/),
      },
    })
    const external = Reflect.get(prerenderConfig.rollupConfig, "external")
    if (!isCallable(external)) throw new TypeError("Expected the prerender external predicate.")
    expect(external("cloudflare:email")).toBe(false)
    expect(external("cloudflare:workers")).toBe(false)
  })

  it("overrides matching regex externals for Cloudflare prerender imports", async () => {
    const config = await applyDeploymentConfig({ host: "cloudflare" })
    // SAFETY: applyDeploymentConfig installs the Cloudflare prerender hook record.
    const hooks = (config.nitro as { hooks: Record<string, unknown> }).hooks
    // SAFETY: The deployment plugin installs this exact async prerender hook.
    const prerender = hooks["prerender:config"] as (config: Record<string, unknown>) => Promise<void>
    const prerenderConfig = { rollupConfig: { external: [/^cloudflare:/, /^node:/] } }

    await prerender(prerenderConfig)

    const external = Reflect.get(prerenderConfig.rollupConfig, "external")
    if (!isCallable(external)) throw new TypeError("Expected the prerender external predicate.")
    expect(external("cloudflare:email")).toBe(false)
    expect(external("cloudflare:workers")).toBe(false)
    expect(external("node:fs")).toBe(true)
  })

  it("leaves deployment output to the Nitro module matching the active preset", async () => {
    const config = await applyDeploymentConfig({ host: "cloudflare", sandboxTask: true })
    // SAFETY: applyDeploymentConfig populated Nitro commands and modules for the Sandbox preset.
    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        commands: { ...nitroConfig.commands },
        output: { dir: "/app/.output", serverDir: "/app/.output/server" },
        preset: "node_server",
        rootDir: "/app",
      },
    }
    // SAFETY: The deployment host plugin prepends its Nitro module to the module list.
    const module = nitroConfig.modules[0] as (target: typeof nitro) => void

    module(nitro)

    expect(nitro.hooks.hook).not.toHaveBeenCalled()
    expect(nitro.options.commands).toEqual({})
  })

  it("keeps deployment-owned Nitro configuration out of development", async () => {
    const config: Record<string, unknown> = {
      nitro: {
        commands: { preview: "node ./preview.mjs" },
        modules: ["local-module"],
        preset: "node-server",
        rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } },
      },
    }
    const presetPlugin = dependencyPluginByName(vitehub({ host: "deno" }), "vite-hub/deployment-host")
    await callHook(presetPlugin.config, [config, { command: "serve", mode: "development" }])

    expect(config.nitro).toEqual({
      commands: { preview: "node ./preview.mjs" },
      modules: ["local-module"],
      preset: "node-server",
      rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } },
    })
  })

  it("preserves array-valued Rollup outputs for Deno", async () => {
    const config = {
      nitro: {
        rollupConfig: {
          output: [
            { chunkFileNames: "chunks/[name].mjs" },
            { assetFileNames: "assets/[name][extname]" },
          ],
        },
      },
    }
    const plugin = dependencyPluginByName(vitehub({ host: "deno" }), "vite-hub/deployment-host")
    await callHook(plugin.config, [config, { command: "build", mode: "production" }])

    expect(config.nitro).toMatchObject({
      rollupConfig: {
        output: [
          { chunkFileNames: "chunks/[name].mjs", entryFileNames: "index.mjs" },
          { assetFileNames: "assets/[name][extname]", entryFileNames: "index.mjs" },
        ],
      },
    })
  })

  it("allows custom alias resolvers until Deno Schedule output is staged", () => {
    const plugin = dependencyPluginByName(vitehub({ host: "deno" }), "vite-hub/deployment-output")
    const customResolver = { resolveId: vi.fn() }

    expect(() => callHook(plugin.configResolved, [{
      command: "build",
      nitro: { preset: "deno-server" },
      plugins: [],
      resolve: { alias: [{ customResolver, find: "#app", replacement: "/app/index.ts" }] },
    }])).not.toThrow()
  })

  it("forwards resolved aliases and Nitro server conditions to Deno output staging", async () => {
    integrationMocks.finalizeDenoDeploymentOutput.mockClear()
    integrationMocks.finalizeDeploymentPlanOutput.mockClear()
    const plugins = vitehub({ host: "deno" })
    const preset = dependencyPluginByName(plugins, "vite-hub/deployment-host")
    const output = dependencyPluginByName(plugins, "vite-hub/deployment-output")
    const config: Record<string, unknown> = {}
    await callHook(preset.config, [config, { command: "build", mode: "production" }])
    callHook(output.config, [{ resolve: { conditions: ["browser", "launch"] } }, { command: "build", mode: "production" }])
    // SAFETY: The preset config hook populated Nitro modules for the Deno build above.
    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    vi.stubEnv("NODE_ENV", "production")
    let resolvedConfig: Awaited<ReturnType<typeof resolveConfig>>
    try {
      resolvedConfig = await resolveConfig({
        resolve: { conditions: ["browser", "launch"] },
      }, "build", "staging")
    }
    finally {
      vi.unstubAllEnvs()
    }
    callHook(output.configResolved, [{ ...resolvedConfig, nitro: nitroConfig }])
    let compiled: (() => Promise<void>) | undefined
    const rolldownConfig: { plugins?: unknown } = {}
    const nitro = {
      hooks: {
        hook: vi.fn((name: string, callback: (...args: unknown[]) => unknown) => {
          // SAFETY: Nitro passes the compiled hook no arguments, and this test awaits it.
          if (name === "compiled") compiled = callback as () => Promise<void>
          if (name === "build:config") callback(nitro, { builder: "vite", rolldown: rolldownConfig })
        }),
      },
      options: {
        builder: "vite",
        commands: nitroConfig.commands,
        output: { dir: "/app/.output", serverDir: "/app/.output/server" },
        preset: "deno_server",
        rootDir: "/app",
      },
    }
    // SAFETY: The deployment host plugin prepends its Nitro module to the configured module list.
    const module = nitroConfig.modules[0] as (target: typeof nitro) => void
    module(nitro)
    if (!compiled) throw new TypeError("Expected the Deno output callback.")

    await (compiled as () => Promise<void>)()

    expect(rolldownConfig.plugins).toEqual([{ name: "vitehub:deno-server-packages" }])
    expect(integrationMocks.finalizeDenoDeploymentOutput).toHaveBeenCalledWith(expect.objectContaining({
      conditions: ["browser", "launch"],
      serverPackages: { bundledPackageDirs: [], externalImports: [] },
    }))

    integrationMocks.finalizeDenoDeploymentOutput.mockClear()
    callHook(output.configResolved, [{
      ...resolvedConfig,
      environments: {
        ...resolvedConfig.environments,
        nitro: {
          ...resolvedConfig.environments.ssr,
          resolve: {
            ...resolvedConfig.resolve,
            alias: [
              { find: "#server-first", replacement: "/server/first.ts" },
              { find: "#server-second", replacement: "/server/second.ts" },
            ],
            conditions: ["module", "node", "development|production", "browser", "launch"],
            extensions: [".mts", ".mjs", ".ts", ".js"],
            mainFields: ["server", "module", "main"],
            preserveSymlinks: true,
          },
        },
      },
      resolve: {
        ...resolvedConfig.resolve,
        alias: [
          { find: "#root-only", replacement: "/root/only.ts" },
        ],
      },
      nitro: nitroConfig,
    }])
    compiled = undefined
    module(nitro)
    if (!compiled) throw new TypeError("Expected the updated Deno output callback.")
    await (compiled as () => Promise<void>)()

    expect(integrationMocks.finalizeDenoDeploymentOutput).toHaveBeenCalledWith(expect.objectContaining({
      alias: [
        { customResolver: false, find: "#server-first", replacement: "/server/first.ts" },
        { customResolver: false, find: "#server-second", replacement: "/server/second.ts" },
      ],
      conditions: ["module", "node", "production", "browser", "launch"],
      extensions: [".mts", ".mjs", ".ts", ".js"],
      mainFields: ["server", "module", "main"],
      preserveSymlinks: true,
    }))
  })

  it("composes deployment output through a Nitro module", async () => {
    const config: Record<string, unknown> = { nitro: { modules: ["existing-module"] } }
    const plugin = dependencyPluginByName(vitehub({ host: "node" }), "vite-hub/deployment-host")
    await callHook(plugin.config, [config, { command: "build", mode: "production" }])
    expect(config.nitro).toMatchObject({ modules: [expect.any(Function), "existing-module"] })
  })

  it.each([
    ["cloudflare", "cloudflare-r2"],
    ["netlify", "netlify-blobs"],
    ["node", "fs"],
    ["vercel", "vercel-blob"],
  ] as const)("wires the %s Blob adapter from the deployment plan", (preset, driver) => {
    integrationMocks.hubBlob.mockClear()
    vitehub({ host: preset, blob: true })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(
      expect.objectContaining({ driver }),
      { importBase: "vite-hub/blob", presetDriver: expect.any(Function) },
    )
  })

  it.each([
    ["vercel", true],
    ["vercel", false],
    ["cloudflare", true],
    ["cloudflare", false],
  ] as const)("resolves the Blob driver with the %s host in development (explicit=%s)", async (preset, explicit) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-app-driver-"))
    try {
      const plugins = vitehub({ host: preset, blob: explicit ? { driver: "vercel-blob" } : true })
      const args = integrationMocks.hubBlob.mock.lastCall
      if (!args) throw new Error("Expected the Blob plugin to be installed.")
      const { hubBlob } = await import("../../blob/src/vite.ts")
      const blob = hubBlob(...args)
      if (blob.config && typeof blob.config !== "function") blob.config.order = "post"
      await resolveConfig({
        configFile: false,
        logLevel: "silent",
        plugins: [
          dependencyPluginByName(plugins, "vite-hub/deployment-host"),
          blob,
        ],
        root,
      }, "serve")

      const store = explicit
        ? { driver: "vercel-blob" }
        : preset === "cloudflare" ? { driver: "cloudflare-r2", localFallback: { driver: "fs" } } : { driver: "fs" }
      expect(blob.api.getConfig().blob).toMatchObject({ store })
      const [inspector] = blob.vitehub.inspect!().definitions!
      expect(await inspector?.list()).toMatchObject([{ fields: [{ label: "Development", value: explicit ? "`vite dev` uses the configured `vercel-blob` driver." : expect.stringContaining("Local.") }] }])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves a configured Netlify Blob store name", () => {
    integrationMocks.hubBlob.mockClear()
    vitehub({ host: "netlify", blob: { name: "assets" } })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(expect.objectContaining({
      driver: "netlify-blobs",
      name: "assets",
    }), { importBase: "vite-hub/blob", presetDriver: expect.any(Function) })
  })

  it("keeps Blob disabled until requested and rejects unsupported presets", () => {
    integrationMocks.hubBlob.mockClear()
    expect(appliedPluginNames(vitehub({ host: "node" }))).not.toContain("@vite-hub/blob/vite")
    expect(pluginNames(vitehub({ host: "node", blob: false }))).not.toContain("@vite-hub/blob/vite")
    expect(pluginNames(vitehub({ host: "deno" }))).not.toContain("@vite-hub/blob/vite")
    // Only the `cms` preset case of the default list builds Blob, once without and once with KV for `github()` Sources.
    expect(integrationMocks.hubBlob).toHaveBeenCalledTimes(2)
    // SAFETY: The explicit Deno preset installs the named deployment plugin.
    const deployment = vitehub({ host: "deno", blob: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    expect(() => callHook(deployment.resolveId, ["vite-hub/blob", "/app/server/api.ts"])).toThrow("cannot provide blob")
    expect(() => callHook(deployment.resolveId, [fileURLToPath(import.meta.resolve("vite-hub/blob")), "/app/server/api.ts"])).toThrow("cannot provide blob")
    expect(() => callHook(deployment.resolveId, ["vite-hub/blob/client", "/app/server/api.ts"])).not.toThrow()

    const dependency = dependencyPlugin({ host: "deno" })
    const aliases = pluginAliases(dependency)
    expect(aliases["vite-hub/blob"]).toBeUndefined()
    expect(aliases["vite-hub/blob/client"]).toEqual(expect.any(String))
    expect(() => callHook(dependency.resolveId, ["@vite-hub/blob", "/app/.vitehub/agents.mjs"])).toThrow("Blob is unavailable")
  })

  it("allows the Agent Blob Capability fallback with an explicit Deno Blob store", () => {
    const dependency = dependencyPlugin({ host: "deno", blob: { driver: "fs" } })
    expect(callHook(dependency.resolveId, ["@vite-hub/blob", "/app/.vitehub/agents.mjs"])).toEqual(expect.any(String))
  })

  it("wires supported Sandbox adapters from the deployment plan", () => {
    vitehub({ host: "cloudflare", sandboxTask: true })
    expect(integrationMocks.hubSandboxTask).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "cloudflare" }))
    vitehub({ host: "vercel", sandboxTask: true })
    expect(integrationMocks.hubSandboxTask).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "vercel" }))
  })

  it("keeps Rate Limit in memory on the dev server", async () => {
    const options = { name: "acme", host: "cloudflare", rateLimit: true } as const
    await expect(applyDeploymentConfig(options, {}, "build")).resolves.toMatchObject({
      [VITEHUB_FEATURES]: { rateLimit: { namespace: "acme", provider: "cloudflare" } },
    })
    await expect(applyDeploymentConfig(options, {}, "serve")).resolves.toMatchObject({
      [VITEHUB_FEATURES]: { rateLimit: { namespace: "acme", provider: "memory" } },
    })
  })

  it("uses the nearest package name for the deployment identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-identity-"))
    const appRoot = join(root, "apps/api")
    await mkdir(appRoot, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@acme/My App" }))

    try {
      const config = await applyDeploymentConfig(
        { host: "cloudflare", blob: true, queue: true, rateLimit: true, sandboxTask: true },
        { root: appRoot },
      )
      expect(config).toMatchObject({
        [VITEHUB_FEATURES]: { blob: { bucketName: "acme-my-app", driver: "cloudflare-r2" }, queue: { namePrefix: "acme-my-app-", provider: "cloudflare" }, rateLimit: { namespace: "acme-my-app", provider: "cloudflare" }, sandboxTask: { name: "acme-my-app-sandbox", provider: "cloudflare" } },
        nitro: { cloudflare: { wrangler: { name: "acme-my-app" } } },
      })

      const configuredRateLimit = await applyDeploymentConfig(
        {
          host: "cloudflare",
          rateLimit: { projectRoot: "packages/policies", scanDirs: ["rules"] },
        },
        { root: appRoot },
      )
      expect(getResolvedFeatureOptions(configuredRateLimit, "rateLimit")).toEqual({
        namespace: "acme-my-app",
        projectRoot: "packages/policies",
        provider: "cloudflare",
        scanDirs: ["rules"],
      })

      await rm(join(root, "package.json"))
      const fallback = await applyDeploymentConfig(
        { host: "cloudflare", queue: true },
        { root: appRoot },
      )
      expect(getResolvedFeatureOptions(fallback, "queue")).toMatchObject({ namePrefix: "api-" })
    }
    finally {
      await rm(root, { recursive: true })
    }
  })

  describe("Cloudflare Workers Builds deployment identity", () => {
    const previousProviderName = process.env.WRANGLER_CI_OVERRIDE_NAME

    beforeEach(() => {
      delete process.env.WRANGLER_CI_OVERRIDE_NAME
    })

    afterEach(() => {
      if (previousProviderName === undefined) delete process.env.WRANGLER_CI_OVERRIDE_NAME
      else process.env.WRANGLER_CI_OVERRIDE_NAME = previousProviderName
    })

    it("uses the connected Worker for every Cloudflare resource default", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      const config = await applyDeploymentConfig({
        blob: true,
        host: "cloudflare",
        queue: true,
        rateLimit: true,
        sandboxTask: true,
      })

      expect(config).toMatchObject({
        [VITEHUB_FEATURES]: { blob: { bucketName: "vitehub-drop-preview", driver: "cloudflare-r2" }, queue: { namePrefix: "vitehub-drop-preview-", provider: "cloudflare" }, rateLimit: { namespace: "vitehub-drop-preview", provider: "cloudflare" }, sandboxTask: { name: "vitehub-drop-preview-sandbox", provider: "cloudflare" } },
        nitro: { cloudflare: { wrangler: { name: "vitehub-drop-preview" } } },
      })
    })

    it("allows a matching explicit deployment identity", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      const config = await applyDeploymentConfig({
        name: "ViteHub Drop Preview",
        host: "cloudflare",
      })

      expect(config.nitro).toMatchObject({
        cloudflare: { wrangler: { name: "vitehub-drop-preview" } },
      })
    })

    it("rejects an explicit deployment identity that conflicts with the connected Worker", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      await expect(applyDeploymentConfig({
        name: "vitehub-drop-production",
        host: "cloudflare",
      })).rejects.toThrow("conflicts with WRANGLER_CI_OVERRIDE_NAME")
    })

    it("rejects an invalid connected Worker identity", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "---"

      await expect(applyDeploymentConfig({
        host: "cloudflare",
      })).rejects.toThrow("WRANGLER_CI_OVERRIDE_NAME must contain at least one letter or number")
    })

    it("ignores the connected Worker for non-Cloudflare hosts", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      const config = await applyDeploymentConfig({
        name: "node-app",
        host: "node",
        rateLimit: true,
      })

      expect(getResolvedFeatureOptions(config, "rateLimit")).toEqual({
        namespace: "node-app",
        provider: "memory",
      })
      expect(config.nitro).not.toHaveProperty("cloudflare")
    })
  })

  it("keeps the full identity while bounding Cloudflare resource defaults", async () => {
    const config = await applyDeploymentConfig({
      blob: true,
      name: "a".repeat(80),
      host: "cloudflare",
      queue: true,
      rateLimit: true,
      sandboxTask: true,
    })
    expect(getResolvedFeatureOptions(config, "blob")).toMatchObject({ bucketName: "a".repeat(48) })
    expect(config.nitro).toMatchObject({ cloudflare: { wrangler: { name: "a".repeat(48) } } })
    // SAFETY: applyDeploymentConfig populated the enabled Queue integration with a string namePrefix.
    expect(getResolvedFeatureOptions<{ namePrefix: string }>(config, "queue")?.namePrefix).toBe(`${"a".repeat(80)}-`)
    expect(getResolvedFeatureOptions(config, "rateLimit")).toMatchObject({ namespace: "a".repeat(80) })
    expect(getResolvedFeatureOptions(config, "sandboxTask")).toMatchObject({ name: `${"a".repeat(48)}-sandbox` })
  })

  it("derives valid R2 bucket defaults from short and truncated identities", async () => {
    const short = await applyDeploymentConfig({
      blob: true,
      name: "ui",
      host: "cloudflare",
    })
    expect(getResolvedFeatureOptions(short, "blob")).toMatchObject({ bucketName: "ui-blob" })

    const truncated = await applyDeploymentConfig({
      blob: true,
      name: `${"a".repeat(47)}-prod`,
      host: "cloudflare",
    })
    expect(getResolvedFeatureOptions(truncated, "blob")).toMatchObject({ bucketName: "a".repeat(47) })
    expect(truncated.nitro).toMatchObject({
      cloudflare: { wrangler: { name: "a".repeat(47) } },
    })
  })

  it("preserves explicit provider and Blob store overrides", async () => {
    const config = await applyDeploymentConfig(
      {
        name: "logical-app",
        host: "cloudflare",
        blob: { bucketName: "explicit-bucket" },
        queue: true,
      },
      { nitro: { cloudflare: { wrangler: { name: "physical-worker" } } } },
    )
    expect(config).toMatchObject({
      [VITEHUB_FEATURES]: { blob: { bucketName: "explicit-bucket", driver: "cloudflare-r2" }, queue: { namePrefix: "logical-app-" } },
      nitro: { cloudflare: { wrangler: { name: "physical-worker" } } },
    })

    integrationMocks.hubBlob.mockClear()
    vitehub({ name: "logical-app", host: "cloudflare", blob: { driver: "fs" } })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(
      expect.objectContaining({ driver: "fs" }),
      { importBase: "vite-hub/blob", presetDriver: expect.any(Function) },
    )
  })

  // Nitro resolves without Vite's `module` condition; Better Auth's @opentelemetry/semantic-conventions then ships whole.
  it("resolves the module export condition in Cloudflare builds", () => {
    const settings = (host: ViteHubOptions["host"]) =>
      // SAFETY: The explicit host installs the named deployment plugin.
      vitehub({ host }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-settings") as Plugin
    const nitroOf = (plugin: Plugin, config: Record<string, unknown>, command: "build" | "serve") => {
      callHook(plugin.config, [config, { command, mode: command === "build" ? "production" : "development" }])
      return config.nitro as { exportConditions?: string[] }
    }
    expect(nitroOf(settings("cloudflare"), {}, "build").exportConditions).toEqual(["module"])
    expect(nitroOf(settings("cloudflare"), { nitro: { exportConditions: ["custom"] } }, "build").exportConditions).toEqual(["custom", "module"])
    expect(nitroOf(settings("cloudflare"), { nitro: { exportConditions: ["!module"] } }, "build").exportConditions).toEqual(["!module"])
    expect(nitroOf(settings("cloudflare"), {}, "serve").exportConditions).toBeUndefined()
    expect(nitroOf(settings("vercel"), {}, "build").exportConditions).toBeUndefined()
  })

  it("rejects unsupported capabilities and conflicting target selection", async () => {
    expect(() => vitehub({ host: "deno", schedule: true })).toThrow("cannot provide Schedule")
    expect(() => vitehub({ host: "deno", agent: { runtime: "deno" } })).toThrow("cannot deploy the Agent Deno runtime")

    // SAFETY: The explicit Deno preset installs the named deployment plugin.
    const unsupported = vitehub({ host: "deno", queue: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    expect(() => callHook(unsupported.config, [{}, { command: "build", mode: "production" }])).toThrow("cannot provide queue")

    // SAFETY: The explicit Node preset installs the named deployment plugin.
    const nodeQueue = vitehub({ host: "node", queue: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    const nodeQueueConfig: Record<string, unknown> = {}
    callHook(nodeQueue.config, [nodeQueueConfig, { command: "build", mode: "production" }])
    expect(getResolvedFeatureOptions(nodeQueueConfig, "queue")).toEqual({ provider: undefined })
    // SAFETY: The explicit Node preset installs the named deployment plugin.
    const postgresQueue = vitehub({ host: "node", queue: { provider: "postgres" } }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    const postgresQueueConfig: Record<string, unknown> = {}
    callHook(postgresQueue.config, [postgresQueueConfig, { command: "build", mode: "production" }])
    expect(getResolvedFeatureOptions(postgresQueueConfig, "queue")).toEqual({ provider: "postgres" })

    const nodePreset = (schedule: ViteHubOptions["schedule"]) =>
      // SAFETY: The explicit Node preset installs the named deployment plugin.
      vitehub({ host: "node", schedule }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    expect(() => callHook(nodePreset(true).config, [{}, { command: "build", mode: "production" }])).toThrow("would never run its Schedules")
    expect(() => callHook(nodePreset({ providerOutput: "auto" }).config, [{}, { command: "build", mode: "production" }])).toThrow("would never run its Schedules")
    expect(() => callHook(nodePreset(true).config, [{}, { command: "serve", mode: "development" }])).not.toThrow()
    expect(() => callHook(nodePreset({ runtime: { driver: "process" } }).config, [{}, { command: "build", mode: "production" }])).not.toThrow()
    expect(() => callHook(nodePreset({ runtime: { driver: "process" }, providerOutput: "auto" }).config, [{}, { command: "build", mode: "production" }])).not.toThrow()
    expect(() => callHook(nodePreset({ runtime: { driver: "process" }, providerOutput: false }).config, [{}, { command: "build", mode: "production" }])).not.toThrow()
    expect(() => callHook(nodePreset({ providerOutput: false }).config, [{}, { command: "build", mode: "production" }])).not.toThrow()

    // SAFETY: The explicit Vercel preset installs the named deployment plugin.
    const conflicting = vitehub({ host: "vercel" }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    expect(() => callHook(conflicting.config, [{ nitro: { preset: "netlify" } }, { command: "build", mode: "production" }])).toThrow("conflicts with nitro.preset")
    expect(() => callHook(conflicting.config, [{ nitro: { preset: "vercel-edge" } }, { command: "build", mode: "production" }])).toThrow("conflicts with nitro.preset")
  })

  it.each(["nitro", "standalone"] as const)("rejects Node Schedule Provider Output %s even with the Process Runtime", providerOutput => {
    // SAFETY: The explicit Node preset installs the named deployment plugin.
    const plugin = vitehub({ host: "node", schedule: { providerOutput, runtime: { driver: "process" } } })
      .find(candidate => (candidate as Plugin).name === "vite-hub/deployment-host") as Plugin
    expect(() => callHook(plugin.config, [{}, { command: "build", mode: "production" }])).toThrow(expect.objectContaining({ name: "VITE_HUB_R0137" }))
    expect(() => callHook(plugin.config, [{}, { command: "serve", mode: "development" }])).not.toThrow()
  })

  it("composes Browser for Cloudflare and rejects unsupported presets", () => {
    const plugins = vitehub({ browser: { binding: "AUTOMATION_BROWSER" }, host: "cloudflare" })
    expect(pluginNames(plugins)).toContain("@vite-hub/browser/vite")
    expect(integrationMocks.hubBrowser).toHaveBeenLastCalledWith({ binding: "AUTOMATION_BROWSER" })
    expect(() => vitehub({ browser: true, host: "node" })).toThrow("requires the Cloudflare host")
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub({ host: "node" })]
    expect(plugins).toHaveLength(1)
  })
})
