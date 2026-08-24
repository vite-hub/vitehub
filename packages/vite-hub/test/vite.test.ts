import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const integrationMocks = vi.hoisted(() => ({
  hubAgent: vi.fn(() => ({ name: "@vite-hub/agent/vite" })),
  hubAuth: vi.fn(() => ({ name: "@vite-hub/auth/vite" })),
  hubBlob: vi.fn(() => ({ name: "@vite-hub/blob/vite" })),
  hubBrowser: vi.fn(() => ({ name: "@vite-hub/browser/vite" })),
  hubChannels: vi.fn(() => ({ name: "@vite-hub/channels/vite" })),
  hubDb: vi.fn(() => ({ name: "@vite-hub/database/vite" })),
  hubEmail: vi.fn(() => ({ name: "@vite-hub/email/vite" })),
  hubEmailOptionalPeerResolver: vi.fn(() => ({ name: "@vite-hub/email/optional-peer-resolver" })),
  hubEnv: vi.fn(() => ({
    api: {
      createServerEnvRegistry: () => ({}),
      getServerEnvRegistry: () => ({}),
      onServerEnvRegistry: () => {},
    },
    name: "@vite-hub/env/vite",
  })),
  hubKv: vi.fn(() => ({ name: "@vite-hub/kv/vite" })),
  hubKvOptionalPeerResolver: vi.fn(() => ({ name: "@vite-hub/kv/optional-peers" })),
  hubMarkdownTemplate: vi.fn(() => ({ name: "@vite-hub/markdown-template/vite" })),
  resolveKVViteConfig: vi.fn((kv?: { driver?: string }, input?: { hosting?: string }) => ({
    kv: { store: { driver: kv?.driver ?? (input?.hosting === "cloudflare-module" ? "cloudflare-kv-binding" : "fs-lite") } },
  })),
  hubQueue: vi.fn(() => ({ name: "@vite-hub/queue/vite" })),
  hubRateLimit: vi.fn(() => ({ name: "@vite-hub/rate-limit/vite" })),
  hubSandbox: vi.fn(() => ({ name: "@vite-hub/sandbox/vite" })),
  hubSchedule: vi.fn(() => ({ name: "@vite-hub/schedule/vite" })),
  hubWorkflow: vi.fn(() => ({ name: "@vite-hub/workflow/vite" })),
  hubWorkspace: vi.fn(() => ({ name: "@vite-hub/workspace/vite" })),
}))

vi.mock("@vite-hub/agent/vite", () => ({ hubAgent: integrationMocks.hubAgent }))
vi.mock("@vite-hub/auth/vite", () => ({ hubAuth: integrationMocks.hubAuth }))
vi.mock("@vite-hub/blob/vite", () => ({ hubBlob: integrationMocks.hubBlob }))
vi.mock("@vite-hub/browser/vite", () => ({ hubBrowser: integrationMocks.hubBrowser }))
vi.mock("@vite-hub/channels/vite", () => ({ hubChannels: integrationMocks.hubChannels }))
vi.mock("@vite-hub/database/vite", () => ({ hubDb: integrationMocks.hubDb }))
vi.mock("@vite-hub/email/vite", () => ({
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
  resolveKVViteConfig: integrationMocks.resolveKVViteConfig,
}))
vi.mock("@vite-hub/markdown-template/vite", () => ({ hubMarkdownTemplate: integrationMocks.hubMarkdownTemplate }))
vi.mock("@vite-hub/queue/vite", () => ({ hubQueue: integrationMocks.hubQueue }))
vi.mock("@vite-hub/rate-limit/vite", () => ({ hubRateLimit: integrationMocks.hubRateLimit }))
vi.mock("@vite-hub/sandbox/vite", () => ({ hubSandbox: integrationMocks.hubSandbox }))
vi.mock("@vite-hub/schedule/vite", () => ({ hubSchedule: integrationMocks.hubSchedule }))
vi.mock("@vite-hub/workflow/vite", () => ({ hubWorkflow: integrationMocks.hubWorkflow }))
vi.mock("@vite-hub/workspace/vite", () => ({ hubWorkspace: integrationMocks.hubWorkspace }))

import type { KVModuleOptions } from "@vite-hub/kv"
import type { Plugin, PluginOption } from "vite"
import frameworkPackageManifest from "../package.json" with { type: "json" }
import { vitehub } from "../src/index.ts"

const deniedGeneratedOwnerPackageNames = new Set(["@vite-hub/cli"])
const generatedOwnerPackageCases = Object.keys(frameworkPackageManifest.dependencies)
  .filter(name => name.startsWith("@vite-hub/"))
  .map(name => [name, deniedGeneratedOwnerPackageNames.has(name) ? "deny" : "resolve"] as const)

// SAFETY: Resolver tests below do not read the Vite plugin context.
const pluginContext = {} as never
// SAFETY: Resolver tests below do not read the Vite resolve options.
const pluginResolveOptions = {} as never

function pluginNames(plugins: PluginOption[]): string[] {
  // SAFETY: vitehub() returns a flat list of concrete plugins in these integration tests.
  return plugins.map(plugin => (plugin as Plugin).name)
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
  const resolver = dependencyPlugin({ preset: "node", blob: true })
  if (!resolver || !isCallable(resolver.resolveId)) throw new TypeError("Expected the framework dependency resolver.")
  return resolver.resolveId
}

function callHook(hook: unknown, args: readonly unknown[]): unknown {
  const candidate = isCallable(hook)
    ? hook
    : isRuntimeRecord(hook) && "handler" in hook
      ? hook.handler
      : undefined
  if (!isCallable(candidate)) throw new TypeError("Expected a callable plugin hook.")
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

function pluginAliases(plugin: Plugin): Record<string, string> {
  const config = callHook(plugin.config, [{}])
  if (!isRuntimeRecord(config) || !("resolve" in config)) throw new TypeError("Expected plugin resolve configuration.")
  const resolve = config.resolve
  if (!isRuntimeRecord(resolve) || !("alias" in resolve)) throw new TypeError("Expected plugin aliases.")
  const alias = resolve.alias
  if (!isStringRecord(alias)) {
    throw new TypeError("Expected plugin aliases to be a string record.")
  }
  // SAFETY: The preceding check validates every alias value.
  return alias as Record<string, string>
}

function dependencyPlugin(options: Parameters<typeof vitehub>[0] = { preset: "node" }): Plugin {
  // SAFETY: The test asserts below that the named plugin exists before returning it.
  const plugin = vitehub(options).find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin | undefined
  if (!plugin) throw new TypeError("Expected the framework dependency resolver.")
  return plugin
}

async function applyDeploymentConfig(
  options: Parameters<typeof vitehub>[0],
  config: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const plugin = dependencyPluginByName(vitehub(options), "vite-hub/deployment-preset")
  await callHook(plugin.config, [config, { command: "build", mode: "production" }])
  return config
}

function dependencyPluginByName(plugins: PluginOption[], name: string): Plugin {
  const plugin = plugins.find(candidate => isRuntimeRecord(candidate) && Reflect.get(candidate, "name") === name)
  if (!plugin) throw new TypeError(`Expected the ${name} plugin.`)
  // SAFETY: The runtime name check above identifies the concrete Vite plugin in this flat plugin list.
  return plugin as Plugin
}

describe("vitehub", () => {
  it("installs the complete console from one option", () => {
    expect(pluginNames(vitehub({ console: true, preset: "node" }))).toEqual(expect.arrayContaining([
      "vite-hub/console",
      "vite-hub/console-invocation-root",
    ]))
  })

  it("keeps coherent defaults and opt-in integrations", () => {
    expect(pluginNames(vitehub({ preset: "node" }))).toEqual([
      "vite-hub/deployment-preset",
      "vite-hub/deployment-output",
      "vite-hub/dependencies",
      "@vite-hub/markdown-template/vite",
      "@vite-hub/env/vite",
      "@vite-hub/email/optional-peer-resolver",
      "@vite-hub/kv/optional-peers",
      "vite-hub/types",
    ])

    expect(pluginNames(vitehub({
      agent: true,
      auth: true,
      blob: true,
      database: true,
      email: { driver: "unemail/driver/resend" },
      channels: true,
      kv: true,
      preset: "cloudflare",
      rateLimit: true,
      sandbox: true,
      schedule: true,
      workflow: true,
      workspace: true,
    }))).toEqual([
      "vite-hub/deployment-preset",
      "vite-hub/deployment-output",
      "vite-hub/dependencies",
      "@vite-hub/markdown-template/vite",
      "@vite-hub/env/vite",
      "@vite-hub/auth/vite",
      "@vite-hub/sandbox/vite",
      "@vite-hub/agent/vite",
      "@vite-hub/channels/vite",
      "@vite-hub/database/vite",
      "@vite-hub/blob/vite",
      "@vite-hub/email/vite",
      "@vite-hub/kv/vite",
      "@vite-hub/rate-limit/vite",
      "@vite-hub/schedule/vite",
      "@vite-hub/workflow/vite",
      "@vite-hub/workspace/vite",
      "vite-hub/types",
    ])
    expect(pluginNames(vitehub({ preset: "node", sandbox: false }))).not.toContain("@vite-hub/sandbox/vite")
    expect(pluginNames(vitehub({ agent: true, preset: "node" }))).toContain("@vite-hub/workflow/vite")
    expect(pluginNames(vitehub({ agent: true, preset: "node", workflow: false }))).not.toContain("@vite-hub/workflow/vite")

    vitehub({
      agent: true,
      blob: true,
      database: true,
      preset: "node",
      schedule: true,
      workflow: true,
      workspace: true,
    })

    expect(integrationMocks.hubMarkdownTemplate).toHaveBeenLastCalledWith({
      runtimeImport: "vite-hub/_internal/markdown-template",
    })
    expect(integrationMocks.hubAuth).toHaveBeenLastCalledWith({}, {
      importBase: "vite-hub/auth",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith({
      cloudflareStateImport: "vite-hub/_internal/agent/cloudflare/state",
      importBase: "vite-hub/_internal/agent",
      processDiscordGateway: true,
      providerImportAliases: {
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
      },
      runtimeCapabilityImports: {
        blob: "vite-hub/_internal/blob",
        db: "vite-hub/database/drizzle",
        email: "vite-hub/email/server",
        kv: "vite-hub/_internal/kv",
      },
      scheduleRuntimeImport: "vite-hub/_internal/schedule/runtime",
      workflowImportBase: "vite-hub/_internal/workflow",
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
      workspaceImportBase: "vite-hub/_internal/workspace",
    })
    expect(integrationMocks.hubAgent).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith({ driver: "fs" }, {
      importBase: "vite-hub/_internal/blob",
      nitroOwned: true,
    })
    expect(integrationMocks.hubDb).toHaveBeenLastCalledWith(undefined)
    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      driver: "unemail/driver/resend",
      hosting: "cloudflare-module",
      runtimeEnvImport: "vite-hub/env/server",
    })
    expect(integrationMocks.hubChannels).toHaveBeenLastCalledWith(undefined)
    expect(integrationMocks.hubKv).toHaveBeenLastCalledWith({ driver: "cloudflare-kv-binding" })
    expect(integrationMocks.hubSandbox).toHaveBeenLastCalledWith({
      provider: "cloudflare",
      providerImportAliases: expect.any(Object),
      providerImportSpecifier: "vite-hub/sandbox",
    })
    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith({
      importBase: "vite-hub/_internal/schedule",
      providerImportAliases: {
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
      },
      runtimeImport: "vite-hub/_internal/schedule/runtime/static",
    })
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, {
      agentImportBase: "vite-hub/_internal/agent",
      hosting: "node-server",
      importBase: "vite-hub/_internal/workflow",
      providerImportAliases: {
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
      },
      includeUserAppEntry: true,
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
      workspaceImportBase: "vite-hub/_internal/workspace",
    })
    expect(integrationMocks.hubWorkflow).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    vitehub({ agent: true, preset: "node" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      runtimeCapabilityImports: expect.objectContaining({ db: false }),
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      implicitlyEnabled: true,
      includeUserAppEntry: false,
    }))
    expect(integrationMocks.hubWorkspace).toHaveBeenLastCalledWith({
      hosting: "node-server",
      importBase: "vite-hub/_internal/workspace",
    })

    vitehub({
      agent: { imports: false },
      database: { cli: { generate: false } },
      preset: "node",
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
    expect(pluginNames(vitehub({ preset: "vercel", queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({
      provider: "vercel",
      providerImportAliases: expect.any(Object),
    })
    expect(pluginNames(vitehub({ preset: "cloudflare", queue: true }))).toContain("@vite-hub/queue/vite")
    expect(integrationMocks.hubQueue).toHaveBeenLastCalledWith({
      provider: "cloudflare",
      providerImportAliases: expect.any(Object),
    })

    integrationMocks.hubRateLimit.mockClear()
    expect(pluginNames(vitehub({ preset: "node", rateLimit: true }))).toContain("@vite-hub/rate-limit/vite")
    expect(integrationMocks.hubRateLimit).toHaveBeenLastCalledWith({
      importBase: "vite-hub/_internal/rate-limit",
      provider: "memory",
    })
    expect(pluginNames(vitehub({ preset: "cloudflare", rateLimit: true }))).toContain("@vite-hub/rate-limit/vite")
    expect(integrationMocks.hubRateLimit).toHaveBeenLastCalledWith({
      importBase: "vite-hub/_internal/rate-limit",
      provider: "cloudflare",
    })
  })

  it("passes configured Email drivers through the canonical integration", () => {
    const email = {
      driver: "unemail/driver/resend" as const,
      options: { endpoint: "https://api.resend.com" },
    }

    vitehub({ email, preset: "node" })

    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      ...email,
      hosting: "node-server",
      runtimeEnvImport: "vite-hub/env/server",
      workflowProvider: undefined,
    })

    vitehub({ email, preset: "node", workflow: { provider: "vercel" } })
    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith(expect.objectContaining({ workflowProvider: "vercel" }))
  })

  it("uses Cloudflare Email when Email is enabled by preset", () => {
    vitehub({ email: true, preset: "cloudflare" })

    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith({
      driver: "unemail/driver/cloudflare-email",
      hosting: "cloudflare-module",
      runtimeEnvImport: "vite-hub/env/server",
      workflowProvider: undefined,
    })
  })

  it("rejects the Cloudflare Email default on other presets", () => {
    expect(() => vitehub({ email: true, preset: "node" })).toThrow("requires the Cloudflare deployment preset")
  })

  it("passes the active host to Workflow inference", () => {
    vitehub({ preset: "cloudflare", schedule: true, workflow: true })

    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith(expect.not.objectContaining({
      providerOutput: expect.anything(),
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "cloudflare-module",
    }))

    vitehub({ preset: "vercel", schedule: true, workflow: true })

    expect(integrationMocks.hubSchedule).toHaveBeenLastCalledWith(expect.objectContaining({
      providerOutput: "standalone",
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "vercel",
    }))

    vitehub({ preset: "netlify", schedule: true, workflow: true })

    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      hosting: "netlify",
    }))
  })

  it("uses framework subpaths in generated Env modules", () => {
    vitehub({ preset: "node" })

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      runtimeImports: {
        secret: "vite-hub/env/secret",
        server: "vite-hub/env/server",
      },
    })

    vitehub({
      preset: "node",
      env: {
        diagnostics: "trace",
        runtimeImports: { server: "#app/env/server" },
      },
    })

    expect(integrationMocks.hubEnv).toHaveBeenLastCalledWith({
      diagnostics: "trace",
      runtimeImports: {
        secret: "vite-hub/env/secret",
        server: "#app/env/server",
      },
    })
  })

  it("keeps Sandbox loaders aligned with preset enablement", () => {
    vitehub({ agent: true, preset: "cloudflare", sandbox: true, workflow: true })

    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        sandbox: "vite-hub/sandbox",
        sandboxRuntimeState: "vite-hub/_internal/sandbox/runtime/state",
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({}, expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        sandbox: "vite-hub/sandbox",
        sandboxRuntimeState: "vite-hub/_internal/sandbox/runtime/state",
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))

    vitehub({ agent: true, preset: "node", workflow: true })

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
    vitehub({ agent: true, preset: "cloudflare" })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.not.objectContaining({
      providers: expect.anything(),
    }))

    vitehub({
      agent: { providers: { state: { provider: "libsql", url: "libsql://state.example.test" } } },
      preset: "cloudflare",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      providers: { state: { provider: "libsql", url: "libsql://state.example.test" } },
    }))

    vitehub({
      agent: { providers: { state: { url: "libsql://state.example.test" } } },
      preset: "cloudflare",
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
      "@vite-hub/env/server",
      "\0#vitehub/env/server",
      pluginResolveOptions,
    )).toMatch(/\/env\/dist\/server\.js$/)
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
      "vite-hub/_internal/blob/runtime/state",
      "/app/.vitehub/nitro/blob/plugin.ts",
      pluginResolveOptions,
    )).toMatch(/\/vite-hub\/dist\/_internal\/blob\/runtime\/state\.js$/)
  })

  it("resolves provider facades after framework aliasing", async () => {
    const plugin = dependencyPlugin({ preset: "vercel", sandbox: true })
    const frameworkSandboxFacade = pluginAliases(plugin)["vite-hub/sandbox"]
    const sandboxAliases = providerAliasesFromCall(integrationMocks.hubSandbox.mock.calls.at(-1))
    const providerSandboxFacade = "/app/.vitehub/sandbox/provider.mjs"

    sandboxAliases["@vite-hub/sandbox"] = providerSandboxFacade
    sandboxAliases["vite-hub/sandbox"] = providerSandboxFacade

    const resolveId = plugin.resolveId
    if (!isCallable(resolveId)) throw new TypeError("Expected the framework dependency resolver.")
    expect(await resolveId.call(pluginContext, "vite-hub/sandbox", "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxFacade)
    expect(await resolveId.call(pluginContext, "@vite-hub/sandbox", "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxFacade)
    expect(await resolveId.call(pluginContext, frameworkSandboxFacade, "/app/server.ts", pluginResolveOptions)).toBe(providerSandboxFacade)
    expect(await resolveId.call(pluginContext, "@vite-hub/kv/runtime/upstash-driver", "/app/server.ts", pluginResolveOptions)).toBeUndefined()
  })

  it.each(generatedOwnerPackageCases)("classifies generated import %s as %s", async (name, access) => {
    // SAFETY: This resolver does not read the Vite plugin context or resolve options in these cases.
    const resolved = await dependencyResolver().call(pluginContext, name, "\0#vitehub/env/server", pluginResolveOptions)
    if (access === "deny") expect(resolved).toBeUndefined()
    else expect(resolved).toBe(fileURLToPath(import.meta.resolve(name)))
  })

  it("keeps third-party driver fallbacks out of the global alias map", async () => {
    const plugin = dependencyPlugin()
    const aliases = pluginAliases(plugin)

    expect(aliases).not.toHaveProperty("vite-hub")
    expect(aliases).not.toHaveProperty("unstorage/drivers/upstash")
    expect(aliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    expect(aliases["vite-hub/_internal/agent/server/internal"]).toMatch(/packages\/vite-hub\/dist\/_internal\/agent\/server\/internal\.js$/)
    expect(aliases["vite-hub/_internal/sandbox/runtime/state"]).toMatch(/packages\/vite-hub\/dist\/_internal\/sandbox\/runtime\/state\.js$/)
    expect(aliases["vite-hub/shell/workspace"]).toMatch(/packages\/vite-hub\/dist\/shell\/workspace\.js$/)
  })

  it("passes the unused Upstash fallback only to provider bundlers", () => {
    vitehub({ agent: true, preset: "node", workflow: true })
    const defaultAliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    expect(defaultAliases).toEqual({
      "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
    })

    const upstashPlugins = vitehub({ agent: true, preset: "node", kv: true, workflow: true })
    const upstashAliases = providerAliasesFromCall(integrationMocks.hubAgent.mock.calls.at(-1))
    // SAFETY: The dependency plugin is part of every vitehub() result.
    const dependency = upstashPlugins.find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin
    callHook(dependency.configResolved, [{ kv: { driver: "upstash" } satisfies KVModuleOptions }])

    expect(upstashAliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    expect(providerAliasesFromCall(integrationMocks.hubWorkflow.mock.calls.at(-1), 1)).toBe(upstashAliases)
  })

  it.each([
    ["cloudflare", "cloudflare-module"],
    ["netlify", "netlify"],
    ["vercel", "vercel"],
    ["deno", "deno-deploy"],
    ["node", "node-server"],
  ] as const)("maps the %s deployment plan to Nitro %s", async (preset, nitroPreset) => {
    const config: Record<string, unknown> = preset === "deno"
      ? { nitro: { rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } } } }
      : {}
    const plugin = dependencyPluginByName(vitehub({ preset }), "vite-hub/deployment-preset")
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

  it("preserves an explicit Cloudflare WASM loading mode", async () => {
    const config = await applyDeploymentConfig(
      { preset: "cloudflare" },
      { nitro: { wasm: { lazy: false } } },
    )

    expect(config.nitro).toMatchObject({ wasm: { lazy: false } })
  })

  it("uses Nitro's Durable Object transport for Cloudflare realtime", async () => {
    const config = await applyDeploymentConfig({ preset: "cloudflare", realtime: true })

    expect(config.nitro).toMatchObject({
      preset: "cloudflare-durable",
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

  it("deploys Cloudflare Sandbox containers through the generated Nitro command", async () => {
    const userModule = (nitro: { options: { commands: Record<string, unknown> } }) => {
      nitro.options.commands.deploy = "node ./deploy.mjs"
    }
    const config = await applyDeploymentConfig(
      { preset: "cloudflare", sandbox: true },
      { nitro: { commands: { preview: "node ./preview.mjs" }, modules: [userModule] } },
    )

    // SAFETY: applyDeploymentConfig has populated Nitro commands and modules for the Cloudflare Sandbox preset.
    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    // SAFETY: The deployment preset prepends its Nitro module to the configured module list.
    const module = nitroConfig.modules[0] as (nitro: {
      hooks: { hook: ReturnType<typeof vi.fn> }
      options: {
        commands: Record<string, unknown>
        output: { dir: string, serverDir: string }
        rootDir: string
      }
    }) => void
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        commands: nitroConfig.commands,
        output: { dir: "/app/.output", serverDir: "/app/.output/cloudflare worker" },
        preset: "cloudflare_module",
        rootDir: "/app",
      },
    }
    module(nitro)

    expect(nitro.options).toMatchObject({
      commands: {
        deploy: "npx wrangler --cwd './cloudflare worker' deploy --containers-rollout=gradual",
        preview: "node ./preview.mjs",
      },
    })
    expect(nitroConfig.modules[1]).toBe(userModule)
    userModule(nitro)
    expect(nitro.options.commands.deploy).toBe("node ./deploy.mjs")
  })

  it("preserves an explicit Cloudflare Sandbox deploy command", async () => {
    const plugins = vitehub({ preset: "cloudflare", sandbox: true })
    // SAFETY: The explicit preset and Sandbox option install both named plugins.
    const preset = plugins.find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    // SAFETY: The explicit preset and Sandbox option install both named plugins.
    const output = plugins.find(candidate => (candidate as Plugin).name === "vite-hub/deployment-output") as Plugin
    const config: Record<string, unknown> = { nitro: { commands: { deploy: "node ./deploy.mjs" } } }
    await callHook(preset.config, [config, { command: "build", mode: "production" }])

    // SAFETY: The preset config hook populated Nitro commands and modules above.
    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    nitroConfig.commands.deploy = "npx wrangler --cwd ./ deploy"
    callHook(output.configResolved, [{ command: "build", nitro: nitroConfig }])
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        commands: nitroConfig.commands,
        output: { dir: "/app/.output", serverDir: "/app/.output/server" },
        preset: "cloudflare_module",
        rootDir: "/app",
      },
    }
    // SAFETY: The deployment preset prepends its Nitro module to the module list.
    const module = nitroConfig.modules[0] as (target: typeof nitro) => void
    module(nitro)

    expect(nitro.options).toMatchObject({ commands: { deploy: "npx wrangler --cwd ./ deploy" } })
  })

  it("aliases Cloudflare runtime imports during Nitro prerendering", async () => {
    const existingPrerender = vi.fn()
    const config = await applyDeploymentConfig(
      { preset: "cloudflare" },
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
    const config = await applyDeploymentConfig({ preset: "cloudflare" })
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
    const config = await applyDeploymentConfig({ preset: "cloudflare" })
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
    const config = await applyDeploymentConfig({ preset: "cloudflare", sandbox: true })
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
    // SAFETY: The deployment preset prepends its Nitro module to the module list.
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
    const presetPlugin = dependencyPluginByName(vitehub({ preset: "deno" }), "vite-hub/deployment-preset")
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
    const plugin = dependencyPluginByName(vitehub({ preset: "deno" }), "vite-hub/deployment-preset")
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

  it("composes deployment output through a Nitro module", async () => {
    const config: Record<string, unknown> = { nitro: { modules: ["existing-module"] } }
    const plugin = dependencyPluginByName(vitehub({ preset: "node" }), "vite-hub/deployment-preset")
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
    vitehub({ preset, blob: true })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(
      expect.objectContaining({ driver }),
      { importBase: "vite-hub/_internal/blob", nitroOwned: true },
    )
  })

  it("preserves a configured Netlify Blob store name", () => {
    integrationMocks.hubBlob.mockClear()
    vitehub({ preset: "netlify", blob: { name: "assets" } })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(expect.objectContaining({
      driver: "netlify-blobs",
      name: "assets",
    }), { importBase: "vite-hub/_internal/blob", nitroOwned: true })
  })

  it("keeps Blob disabled until requested and rejects unsupported presets", () => {
    integrationMocks.hubBlob.mockClear()
    expect(pluginNames(vitehub({ preset: "node" }))).not.toContain("@vite-hub/blob/vite")
    expect(pluginNames(vitehub({ preset: "deno" }))).not.toContain("@vite-hub/blob/vite")
    expect(integrationMocks.hubBlob).not.toHaveBeenCalled()
    // SAFETY: The explicit Deno preset installs the named deployment plugin.
    const deployment = vitehub({ preset: "deno", blob: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    expect(() => callHook(deployment.resolveId, ["vite-hub/blob", "/app/server/api.ts"])).toThrow("cannot provide blob")
    expect(() => callHook(deployment.resolveId, [fileURLToPath(import.meta.resolve("vite-hub/blob")), "/app/server/api.ts"])).toThrow("cannot provide blob")
    expect(() => callHook(deployment.resolveId, ["vite-hub/blob/content-type", "/app/server/api.ts"])).not.toThrow()

    const dependency = dependencyPlugin({ preset: "deno" })
    // SAFETY: dependencyPlugin returns the concrete plugin whose config hook supplies this alias shape.
    const config = (dependency.config as () => { resolve: { alias: Record<string, string> } })()
    expect(config.resolve.alias["vite-hub/blob"]).toBeUndefined()
    expect(config.resolve.alias["vite-hub/blob/content-type"]).toEqual(expect.any(String))
    expect(() => callHook(dependency.resolveId, ["@vite-hub/blob", "/app/.vitehub/agents.mjs"])).toThrow("Blob is unavailable")
  })

  it("allows the Agent Blob Capability fallback with an explicit Deno Blob store", () => {
    const dependency = dependencyPlugin({ preset: "deno", blob: { driver: "fs" } })
    expect(callHook(dependency.resolveId, ["@vite-hub/blob", "/app/.vitehub/agents.mjs"])).toEqual(expect.any(String))
  })

  it("wires supported Sandbox adapters from the deployment plan", () => {
    vitehub({ preset: "cloudflare", sandbox: true })
    expect(integrationMocks.hubSandbox).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "cloudflare" }))
    vitehub({ preset: "vercel", sandbox: true })
    expect(integrationMocks.hubSandbox).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "vercel" }))
  })

  it("uses the nearest package name for the deployment identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-identity-"))
    const appRoot = join(root, "apps/api")
    await mkdir(appRoot, { recursive: true })
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@acme/My App" }))

    try {
      const config = await applyDeploymentConfig(
        { preset: "cloudflare", blob: true, queue: true, rateLimit: true, sandbox: true },
        { root: appRoot },
      )
      expect(config).toMatchObject({
        blob: { bucketName: "acme-my-app", driver: "cloudflare-r2" },
        nitro: { cloudflare: { wrangler: { name: "acme-my-app" } } },
        queue: { namePrefix: "acme-my-app-", provider: "cloudflare" },
        rateLimit: { namespace: "acme-my-app", provider: "cloudflare" },
        sandbox: { name: "acme-my-app-sandbox", provider: "cloudflare" },
      })

      await rm(join(root, "package.json"))
      const fallback = await applyDeploymentConfig(
        { preset: "cloudflare", queue: true },
        { root: appRoot },
      )
      expect(fallback.queue).toMatchObject({ namePrefix: "api-" })
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
        preset: "cloudflare",
        queue: true,
        rateLimit: true,
        sandbox: true,
      })

      expect(config).toMatchObject({
        blob: { bucketName: "vitehub-drop-preview", driver: "cloudflare-r2" },
        nitro: { cloudflare: { wrangler: { name: "vitehub-drop-preview" } } },
        queue: { namePrefix: "vitehub-drop-preview-", provider: "cloudflare" },
        rateLimit: { namespace: "vitehub-drop-preview", provider: "cloudflare" },
        sandbox: { name: "vitehub-drop-preview-sandbox", provider: "cloudflare" },
      })
    })

    it("allows a matching explicit deployment identity", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      const config = await applyDeploymentConfig({
        name: "ViteHub Drop Preview",
        preset: "cloudflare",
      })

      expect(config.nitro).toMatchObject({
        cloudflare: { wrangler: { name: "vitehub-drop-preview" } },
      })
    })

    it("rejects an explicit deployment identity that conflicts with the connected Worker", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      await expect(applyDeploymentConfig({
        name: "vitehub-drop-production",
        preset: "cloudflare",
      })).rejects.toThrow("conflicts with WRANGLER_CI_OVERRIDE_NAME")
    })

    it("rejects an invalid connected Worker identity", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "---"

      await expect(applyDeploymentConfig({
        preset: "cloudflare",
      })).rejects.toThrow("WRANGLER_CI_OVERRIDE_NAME must contain at least one letter or number")
    })

    it("ignores the connected Worker for non-Cloudflare presets", async () => {
      process.env.WRANGLER_CI_OVERRIDE_NAME = "vitehub-drop-preview"

      const config = await applyDeploymentConfig({
        name: "node-app",
        preset: "node",
        rateLimit: true,
      })

      expect(config.rateLimit).toEqual({
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
      preset: "cloudflare",
      queue: true,
      rateLimit: true,
      sandbox: true,
    })
    expect(config.blob).toMatchObject({ bucketName: "a".repeat(48) })
    expect(config.nitro).toMatchObject({ cloudflare: { wrangler: { name: "a".repeat(48) } } })
    // SAFETY: applyDeploymentConfig populated the enabled Queue integration with a string namePrefix.
    expect((config.queue as { namePrefix: string }).namePrefix).toBe(`${"a".repeat(80)}-`)
    expect(config.rateLimit).toMatchObject({ namespace: "a".repeat(80) })
    expect(config.sandbox).toMatchObject({ name: `${"a".repeat(48)}-sandbox` })
  })

  it("derives valid R2 bucket defaults from short and truncated identities", async () => {
    const short = await applyDeploymentConfig({
      blob: true,
      name: "ui",
      preset: "cloudflare",
    })
    expect(short.blob).toMatchObject({ bucketName: "ui-blob" })

    const truncated = await applyDeploymentConfig({
      blob: true,
      name: `${"a".repeat(47)}-prod`,
      preset: "cloudflare",
    })
    expect(truncated.blob).toMatchObject({ bucketName: "a".repeat(47) })
    expect(truncated.nitro).toMatchObject({
      cloudflare: { wrangler: { name: "a".repeat(47) } },
    })
  })

  it("preserves explicit provider and Blob store overrides", async () => {
    const config = await applyDeploymentConfig(
      {
        name: "logical-app",
        preset: "cloudflare",
        blob: { bucketName: "explicit-bucket" },
        queue: true,
      },
      { nitro: { cloudflare: { wrangler: { name: "physical-worker" } } } },
    )
    expect(config).toMatchObject({
      blob: { bucketName: "explicit-bucket", driver: "cloudflare-r2" },
      nitro: { cloudflare: { wrangler: { name: "physical-worker" } } },
      queue: { namePrefix: "logical-app-" },
    })

    integrationMocks.hubBlob.mockClear()
    vitehub({ name: "logical-app", preset: "cloudflare", blob: { driver: "fs" } })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(
      expect.objectContaining({ driver: "fs" }),
      { importBase: "vite-hub/_internal/blob", nitroOwned: true },
    )
  })

  it("rejects unsupported capabilities and conflicting target selection", async () => {
    expect(() => vitehub({ preset: "deno", schedule: true })).toThrow("cannot provide Schedule")
    expect(() => vitehub({ preset: "deno", agent: { runtime: "deno" } })).toThrow("cannot deploy the Agent Deno runtime")

    // SAFETY: The explicit Deno preset installs the named deployment plugin.
    const unsupported = vitehub({ preset: "deno", queue: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    expect(() => callHook(unsupported.config, [{}, { command: "build", mode: "production" }])).toThrow("cannot provide queue")

    // SAFETY: The explicit Vercel preset installs the named deployment plugin.
    const conflicting = vitehub({ preset: "vercel" }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    expect(() => callHook(conflicting.config, [{ nitro: { preset: "netlify" } }, { command: "build", mode: "production" }])).toThrow("conflicts with nitro.preset")
    expect(() => callHook(conflicting.config, [{ nitro: { preset: "vercel-edge" } }, { command: "build", mode: "production" }])).toThrow("conflicts with nitro.preset")
  })

  it("composes Browser for Cloudflare and rejects unsupported presets", () => {
    const plugins = vitehub({ browser: { binding: "AUTOMATION_BROWSER" }, preset: "cloudflare" })
    expect(pluginNames(plugins)).toContain("@vite-hub/browser/vite")
    expect(integrationMocks.hubBrowser).toHaveBeenLastCalledWith({ binding: "AUTOMATION_BROWSER" })
    expect(() => vitehub({ browser: true, preset: "node" })).toThrow("requires the Cloudflare deployment preset")
  })

  it("can be used as one nested Vite plugin entry", () => {
    const plugins: PluginOption[] = [vitehub({ preset: "node" })]
    expect(plugins).toHaveLength(1)
  })
})
