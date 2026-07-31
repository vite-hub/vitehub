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
  hubDb: vi.fn(() => ({ name: "@vite-hub/database/vite" })),
  hubEmail: vi.fn(() => ({ name: "@vite-hub/email/vite" })),
  hubEnv: vi.fn(() => ({ name: "@vite-hub/env/vite" })),
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
vi.mock("@vite-hub/database/vite", () => ({ hubDb: integrationMocks.hubDb }))
vi.mock("@vite-hub/email/vite", () => ({ hubEmail: integrationMocks.hubEmail }))
vi.mock("@vite-hub/env/vite", () => ({ hubEnv: integrationMocks.hubEnv }))
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

function pluginNames(plugins: PluginOption[]): string[] {
  return plugins.map(plugin => (plugin as Plugin).name)
}

function dependencyResolver() {
  const resolver = dependencyPlugin({ preset: "node", blob: true })
  if (!resolver || typeof resolver.resolveId !== "function") throw new TypeError("Expected the framework dependency resolver.")
  return resolver.resolveId
}

function dependencyPlugin(options: Parameters<typeof vitehub>[0] = { preset: "node" }): Plugin {
  const plugin = vitehub(options).find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin | undefined
  if (!plugin) throw new TypeError("Expected the framework dependency resolver.")
  return plugin
}

async function applyDeploymentConfig(
  options: Parameters<typeof vitehub>[0],
  config: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const plugin = vitehub(options)
    .find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
  const hook = plugin.config as unknown as (
    config: Record<string, unknown>,
    env: { command: "build", mode: string },
  ) => void
  await hook(config, { command: "build", mode: "production" })
  return config
}

describe("vitehub", () => {
  it("keeps coherent defaults and opt-in integrations", () => {
    expect(pluginNames(vitehub({ preset: "node" }))).toEqual([
      "vite-hub/deployment-preset",
      "vite-hub/deployment-output",
      "vite-hub/dependencies",
      "@vite-hub/markdown-template/vite",
      "@vite-hub/env/vite",
      "@vite-hub/kv/optional-peers",
      "vite-hub/types",
    ])

    expect(pluginNames(vitehub({
      agent: true,
      auth: true,
      blob: true,
      database: true,
      email: true,
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
    expect(integrationMocks.hubAuth).toHaveBeenLastCalledWith({
      importBase: "vite-hub/auth",
    })
    expect(integrationMocks.hubAgent).toHaveBeenLastCalledWith({
      cloudflareStateImport: "vite-hub/_internal/agent/cloudflare/state",
      importBase: "vite-hub/_internal/agent",
      providerImportAliases: {
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
      },
      runtimeCapabilityImports: {
        blob: "vite-hub/_internal/blob",
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
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith({
      driver: "fs",
      importBase: "vite-hub/_internal/blob",
      nitroOwned: true,
    })
    expect(integrationMocks.hubDb).toHaveBeenLastCalledWith(undefined)
    expect(integrationMocks.hubEmail).toHaveBeenLastCalledWith(undefined)
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
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith({
      agentImportBase: "vite-hub/_internal/agent",
      importBase: "vite-hub/_internal/workflow",
      providerImportAliases: {
        "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
      },
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
      workspaceImportBase: "vite-hub/_internal/workspace",
    })
    expect(integrationMocks.hubWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
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
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "vercel" }))
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
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({
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
    expect(integrationMocks.hubWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceDependencyRuntimeImports: {
        shellWorkspace: "vite-hub/shell/workspace",
      },
    }))
  })

  it("resolves only package-owned imports from generated modules", async () => {
    const resolveId = dependencyResolver()

    expect(await resolveId.call({} as never, "vite-hub/auth/server", "/app/server.ts", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/agent", "/app/server.ts", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/agent", "\0virtual:third-party", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/agent", "/app/.vitehub-other/agent.ts", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/agent", "\0#vitehub/custom", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/workspace/runtime", "\0#vitehub-workspace-registry", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@chat-adapter/discord", "/app/.vitehub/agent/route.ts", {} as never)).toBeUndefined()
    expect(await resolveId.call({} as never, "@vite-hub/agent/server", "/app/.vitehub/agent/route.ts", {} as never))
      .toMatch(/\/agent\/dist\/server\.js$/)
    expect(await resolveId.call({} as never, "@vite-hub/agent/server", "C:\\app\\.vitehub\\agent\\route.ts", {} as never))
      .toMatch(/\/agent\/dist\/server\.js$/)
    expect(await resolveId.call(
      {} as never,
      "@vite-hub/auth/server",
      "\0#vitehub/auth/server",
      {} as never,
    )).toMatch(/\/auth\/dist\/server\.js$/)
    expect(await resolveId.call(
      {} as never,
      "@vite-hub/env/server",
      "\0#vitehub/env/server",
      {} as never,
    )).toMatch(/\/env\/dist\/server\.js$/)
    expect(await resolveId.call(
      {} as never,
      "@vite-hub/schedule/runtime",
      "\0#vitehub/schedule/registry",
      {} as never,
    )).toMatch(/\/schedule\/dist\/runtime\.js$/)
    expect(await resolveId.call(
      {} as never,
      "@vite-hub/agent/cloudflare/state",
      "\0virtual:vitehub-agent-cloudflare-state-exports",
      {} as never,
    )).toMatch(/\/agent\/dist\/cloudflare\/state\.js$/)
    expect(await resolveId.call(
      {} as never,
      "vite-hub/auth/server",
      "\0#vitehub/auth/server",
      {} as never,
    )).toMatch(/\/vite-hub\/dist\/auth\/server\.js$/)
    expect(await resolveId.call(
      {} as never,
      "vite-hub/_internal/blob/runtime/state",
      "/app/.vitehub/nitro/blob/plugin.ts",
      {} as never,
    )).toMatch(/\/vite-hub\/dist\/_internal\/blob\/runtime\/state\.js$/)
  })

  it("resolves provider facades after framework aliasing", async () => {
    const plugin = dependencyPlugin({ preset: "vercel", sandbox: true })
    const config = plugin.config as unknown as (config: object) => { resolve: { alias: Record<string, string> } }
    const frameworkSandboxFacade = config({}).resolve.alias["vite-hub/sandbox"]
    const sandboxCall = integrationMocks.hubSandbox.mock.calls.at(-1) as unknown as [{ providerImportAliases: Record<string, string> }]
    const providerSandboxFacade = "/app/.vitehub/sandbox/provider.mjs"

    sandboxCall[0].providerImportAliases["@vite-hub/sandbox"] = providerSandboxFacade
    sandboxCall[0].providerImportAliases["vite-hub/sandbox"] = providerSandboxFacade

    const resolveId = plugin.resolveId
    if (typeof resolveId !== "function") throw new TypeError("Expected the framework dependency resolver.")
    expect(await resolveId.call({} as never, "vite-hub/sandbox", "/app/server.ts", {} as never)).toBe(providerSandboxFacade)
    expect(await resolveId.call({} as never, "@vite-hub/sandbox", "/app/server.ts", {} as never)).toBe(providerSandboxFacade)
    expect(await resolveId.call({} as never, frameworkSandboxFacade, "/app/server.ts", {} as never)).toBe(providerSandboxFacade)
    expect(await resolveId.call({} as never, "@vite-hub/kv/runtime/upstash-driver", "/app/server.ts", {} as never)).toBeUndefined()
  })

  it.each(generatedOwnerPackageCases)("classifies generated import %s as %s", async (name, access) => {
    const resolved = await dependencyResolver().call({} as never, name, "\0#vitehub/templates", {} as never)
    if (access === "deny") expect(resolved).toBeUndefined()
    else expect(resolved).toBe(fileURLToPath(import.meta.resolve(name)))
  })

  it("keeps third-party driver fallbacks out of the global alias map", async () => {
    const plugin = dependencyPlugin()
    const config = plugin.config as unknown as (config: object) => { resolve: { alias: Record<string, string> } }
    const aliases = config({}).resolve.alias

    expect(aliases).not.toHaveProperty("vite-hub")
    expect(aliases).not.toHaveProperty("unstorage/drivers/upstash")
    expect(aliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    expect(aliases["vite-hub/_internal/agent/server/internal"]).toMatch(/packages\/vite-hub\/dist\/_internal\/agent\/server\/internal\.js$/)
    expect(aliases["vite-hub/_internal/sandbox/runtime/state"]).toMatch(/packages\/vite-hub\/dist\/_internal\/sandbox\/runtime\/state\.js$/)
    expect(aliases["vite-hub/shell/workspace"]).toMatch(/packages\/vite-hub\/dist\/shell\/workspace\.js$/)
  })

  it("passes the unused Upstash fallback only to provider bundlers", () => {
    vitehub({ agent: true, preset: "node", workflow: true })
    const defaultCall = integrationMocks.hubAgent.mock.calls.at(-1) as unknown as [{ providerImportAliases: Record<string, string> }]
    const defaultAliases = defaultCall[0].providerImportAliases
    expect(defaultAliases).toEqual({
      "@vite-hub/kv/runtime/upstash-driver": expect.stringMatching(/packages\/vite-hub\/dist\/_internal\/kv\/runtime\/disabled-upstash\.js$/),
    })

    const upstashPlugins = vitehub({ agent: true, preset: "node", kv: true, workflow: true })
    const upstashCall = integrationMocks.hubAgent.mock.calls.at(-1) as unknown as [{ providerImportAliases: Record<string, string> }]
    const upstashAliases = upstashCall[0].providerImportAliases
    const dependency = upstashPlugins.find(candidate => (candidate as Plugin).name === "vite-hub/dependencies") as Plugin
    const configResolved = dependency.configResolved as unknown as (config: { kv: KVModuleOptions }) => void
    configResolved({ kv: { driver: "upstash" } })

    expect(upstashAliases).not.toHaveProperty("@vite-hub/kv/runtime/upstash-driver")
    const workflowCall = integrationMocks.hubWorkflow.mock.calls.at(-1) as unknown as [{ providerImportAliases: Record<string, string> }]
    expect(workflowCall[0].providerImportAliases).toBe(upstashAliases)
  })

  it.each([
    ["cloudflare", "cloudflare-module"],
    ["netlify", "netlify"],
    ["vercel", "vercel"],
    ["deno", "deno-deploy"],
    ["node", "node-server"],
  ] as const)("maps the %s deployment plan to Nitro %s", async (preset, nitroPreset) => {
    const config = preset === "deno"
      ? { nitro: { rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } } } }
      : {} as Record<string, unknown>
    const plugin = vitehub({ preset }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const hook = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build", mode: string }) => void
    await hook(config, { command: "build", mode: "production" })
    expect(config.nitro).toMatchObject({ preset: nitroPreset })
    if (preset === "deno") {
      expect(config.nitro).toMatchObject({
        commands: { deploy: "node ./deploy.mjs" },
        modules: [expect.any(Function)],
        rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs", entryFileNames: "index.mjs" } },
      })
    }
  })

  it("deploys Cloudflare Sandbox containers through the generated Nitro command", async () => {
    const config = await applyDeploymentConfig(
      { preset: "cloudflare", sandbox: true },
      { nitro: { commands: { preview: "node ./preview.mjs" } } },
    )

    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    const module = nitroConfig.modules.at(-1) as (nitro: {
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
        output: { dir: "/app/.output", serverDir: "/app/.output/worker" },
        rootDir: "/app",
      },
    }
    module(nitro)

    expect(nitro.options).toMatchObject({
      commands: {
        deploy: "npx wrangler --cwd ./worker deploy --containers-rollout=gradual",
        preview: "node ./preview.mjs",
      },
    })
  })

  it("preserves an explicit Cloudflare Sandbox deploy command", async () => {
    const config = await applyDeploymentConfig(
      { preset: "cloudflare", sandbox: true },
      { nitro: { commands: { deploy: "node ./deploy.mjs" } } },
    )

    const nitroConfig = config.nitro as { commands: Record<string, unknown>, modules: unknown[] }
    const nitro = {
      hooks: { hook: vi.fn() },
      options: {
        commands: { deploy: "node ./later-deploy.mjs" },
        output: { dir: "/app/.output", serverDir: "/app/.output/server" },
        rootDir: "/app",
      },
    }
    const module = nitroConfig.modules.at(-1) as (target: typeof nitro) => void
    module(nitro)

    expect(nitro.options).toMatchObject({ commands: { deploy: "node ./later-deploy.mjs" } })
  })

  it("keeps deployment-owned Nitro configuration out of development", async () => {
    const config = {
      nitro: {
        commands: { preview: "node ./preview.mjs" },
        modules: ["local-module"],
        preset: "node-server",
        rollupConfig: { output: { chunkFileNames: "chunks/[name].mjs" } },
      },
    } as Record<string, unknown>
    const plugins = vitehub({ preset: "deno" })
    const presetPlugin = plugins.find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const presetHook = presetPlugin.config as unknown as (
      config: Record<string, unknown>,
      env: { command: "serve", mode: string },
    ) => void

    await presetHook(config, { command: "serve", mode: "development" })

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
    } as Record<string, unknown>
    const plugin = vitehub({ preset: "deno" }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const hook = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build", mode: string }) => void

    await hook(config, { command: "build", mode: "production" })

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
    const config = { nitro: { modules: ["existing-module"] } } as Record<string, unknown>
    const plugin = vitehub({ preset: "node" }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const hook = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build", mode: string }) => void
    await hook(config, { command: "build", mode: "production" })
    expect(config.nitro).toMatchObject({ modules: ["existing-module", expect.any(Function)] })
  })

  it.each([
    ["cloudflare", "cloudflare-r2"],
    ["netlify", "netlify-blobs"],
    ["node", "fs"],
    ["vercel", "vercel-blob"],
  ] as const)("wires the %s Blob adapter from the deployment plan", (preset, driver) => {
    integrationMocks.hubBlob.mockClear()
    vitehub({ preset, blob: true })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(expect.objectContaining({ driver }))
  })

  it("preserves a configured Netlify Blob store name", () => {
    integrationMocks.hubBlob.mockClear()
    vitehub({ preset: "netlify", blob: { name: "assets" } })
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(expect.objectContaining({
      driver: "netlify-blobs",
      name: "assets",
    }))
  })

  it("keeps Blob disabled until requested and rejects unsupported presets", () => {
    integrationMocks.hubBlob.mockClear()
    expect(pluginNames(vitehub({ preset: "node" }))).not.toContain("@vite-hub/blob/vite")
    expect(pluginNames(vitehub({ preset: "deno" }))).not.toContain("@vite-hub/blob/vite")
    expect(integrationMocks.hubBlob).not.toHaveBeenCalled()
    const deployment = vitehub({ preset: "deno", blob: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const resolveId = deployment.resolveId as unknown as (source: string, importer?: string) => void
    expect(() => resolveId("vite-hub/blob", "/app/server/api.ts")).toThrow("cannot provide blob")
    expect(() => resolveId(fileURLToPath(import.meta.resolve("vite-hub/blob")), "/app/server/api.ts")).toThrow("cannot provide blob")
    expect(() => resolveId("vite-hub/blob/content-type", "/app/server/api.ts")).not.toThrow()

    const dependency = dependencyPlugin({ preset: "deno" })
    const config = (dependency.config as () => { resolve: { alias: Record<string, string> } })()
    expect(config.resolve.alias["vite-hub/blob"]).toBeUndefined()
    expect(config.resolve.alias["vite-hub/blob/content-type"]).toEqual(expect.any(String))
    const resolveDependency = dependency.resolveId as unknown as (source: string, importer?: string) => void
    expect(() => resolveDependency("@vite-hub/blob", "/app/.vitehub/agents.mjs")).toThrow("Blob is unavailable")
  })

  it("allows the Agent Blob Capability fallback with an explicit Deno Blob store", () => {
    const dependency = dependencyPlugin({ preset: "deno", blob: { driver: "fs" } })
    const resolveDependency = dependency.resolveId as unknown as (source: string, importer?: string) => unknown
    expect(resolveDependency("@vite-hub/blob", "/app/.vitehub/agents.mjs")).toEqual(expect.any(String))
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
    const previousDeploymentName = process.env.VITEHUB_DEPLOYMENT_NAME
    const previousProviderName = process.env.WRANGLER_CI_OVERRIDE_NAME

    beforeEach(() => {
      delete process.env.VITEHUB_DEPLOYMENT_NAME
      delete process.env.WRANGLER_CI_OVERRIDE_NAME
    })

    afterEach(() => {
      if (previousDeploymentName === undefined) delete process.env.VITEHUB_DEPLOYMENT_NAME
      else process.env.VITEHUB_DEPLOYMENT_NAME = previousDeploymentName
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

      process.env.VITEHUB_DEPLOYMENT_NAME = "vitehub-drop-production"
      await expect(applyDeploymentConfig({
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

  it("keeps explicit and legacy deployment identities deterministic", async () => {
    const previousName = process.env.VITEHUB_DEPLOYMENT_NAME
    process.env.VITEHUB_DEPLOYMENT_NAME = "Legacy App"
    try {
      const explicit = await applyDeploymentConfig({
        name: "legacy-app",
        preset: "cloudflare",
        rateLimit: true,
      })
      expect(explicit.rateLimit).toMatchObject({ namespace: "legacy-app" })

      await expect(applyDeploymentConfig({
        name: "another-app",
        preset: "cloudflare",
      })).rejects.toThrow("conflicts with VITEHUB_DEPLOYMENT_NAME")

      const legacy = await applyDeploymentConfig({
        preset: "cloudflare",
        rateLimit: true,
      })
      expect(legacy.rateLimit).toMatchObject({ namespace: "legacy-app" })

      process.env.VITEHUB_DEPLOYMENT_NAME = `${"a".repeat(48)}-environment`
      await expect(applyDeploymentConfig({
        name: `${"a".repeat(48)}-configured`,
        preset: "cloudflare",
      })).rejects.toThrow("conflicts with VITEHUB_DEPLOYMENT_NAME")
    }
    finally {
      if (previousName === undefined) delete process.env.VITEHUB_DEPLOYMENT_NAME
      else process.env.VITEHUB_DEPLOYMENT_NAME = previousName
    }
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
    expect(integrationMocks.hubBlob).toHaveBeenLastCalledWith(expect.objectContaining({ driver: "fs" }))
  })

  it("rejects unsupported capabilities and conflicting target selection", async () => {
    expect(() => vitehub({ preset: "deno", schedule: true })).toThrow("cannot provide Schedule")
    expect(() => vitehub({ preset: "deno", agent: { runtime: "deno" } })).toThrow("cannot deploy the Agent Deno runtime")

    const unsupported = vitehub({ preset: "deno", queue: true }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const unsupportedHook = unsupported.config as unknown as (config: Record<string, unknown>, env: { command: "build", mode: string }) => void
    expect(() => unsupportedHook({}, { command: "build", mode: "production" })).toThrow("cannot provide queue")

    const conflicting = vitehub({ preset: "vercel" }).find(candidate => (candidate as Plugin).name === "vite-hub/deployment-preset") as Plugin
    const conflictingHook = conflicting.config as unknown as (config: Record<string, unknown>, env: { command: "build", mode: string }) => void
    expect(() => conflictingHook({ nitro: { preset: "netlify" } }, { command: "build", mode: "production" })).toThrow("conflicts with nitro.preset")
    expect(() => conflictingHook({ nitro: { preset: "vercel-edge" } }, { command: "build", mode: "production" })).toThrow("conflicts with nitro.preset")
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
