import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { setResolvedFeatureOptions } from "@vite-hub/internal/build/vite"
import { hubKv } from "@vite-hub/kv/vite"
import { desc } from "drizzle-orm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { defineAgent } from "../src/agent.ts"
import { vitehub } from "../src/index.ts"
import {
  consoleInvocationsBindingKey,
  consoleInvocationsBindingRegistryKey,
  consoleInvocationsBindingRootRegistryKey,
  consoleInvocationsIdentityKey,
  consoleInvocationsIdentityRootKey,
  consoleInvocationsKey,
  consoleInvocationsRegistryKey,
  consoleInvocationsRootIdentityRegistryKey,
  consoleInvocationsRootKey,
  consoleProjectRootKey,
  consoleStateKey,
  installConsoleInvocationFallback,
  resolveConsoleInvocations,
  resolveConsoleProjectRoot,
} from "../src/console/internal.ts"
import { serializeConsoleRefresh } from "../src/console/refresh.ts"
import { listConsoleAgents } from "../src/console/runtime/server/agents.get.ts"
import agentInvocationsHandlerRoute from "../src/console/runtime/server/agent-invocations.post.ts"
import { encodeAgentRouteParam } from "../src/console/runtime/console-route.ts"
import { installConsoleAgentDefinitions, installConsoleAgents } from "../src/console/runtime/server/agents.ts"
import { installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import { createDefaultAgentInvocations, resolveDefaultAgentInvocationsLocation } from "@vite-hub/agent/internal/default-invocations"
import { installAgentInvocations } from "@vite-hub/agent/invocations/app"
import { getAgentInvocationsDatabase } from "@vite-hub/agent/invocations/drizzle"
import type { AgentInvocationsDefault } from "@vite-hub/agent"
import { console as consoleRuntime } from "../src/console/server.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import invocationHandlerRoute, { cancelConsoleInvocation, getConsoleInvocationDetail } from "../src/console/runtime/server/invocation.get.ts"
import { listConsoleInvocationCapabilities } from "../src/console/runtime/server/invocation-capabilities.get.ts"
import { listConsoleInvocations } from "../src/console/runtime/server/invocations.get.ts"
import { isConsoleDevelopmentBuild } from "../src/console/runtime/server/development.ts"
import { assertConsoleRequest } from "../src/console/runtime/server/request.ts"
import { consoleSearchCollectionHandler } from "../src/console/runtime/server/search.get.ts"
import { consoleSearch } from "../src/console/runtime/server/search.ts"
import { listConsoleSections } from "../src/console/runtime/server/sections.get.ts"
import { installConsoleDevelopment, installConsoleProjectName, installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin, updateConsoleInvocationRootState } from "../src/console/vite.ts"
import { readConsoleUsage as usageHandlerRoute } from "../src/console/runtime/server/usage.get.ts"
import { createUsageSummary, invocationUsage } from "../src/console/runtime/server/usage.ts"

import { runAgent } from "@vite-hub/agent"
import { runAgentWithContext } from "@vite-hub/agent/server/internal"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"
import { agentWithColocatedSkills, workspaceAgentWithSourceRoot } from "../../agent/dist/runtime/workflow.js"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { AgentInvocations, AgentRuntimeContext } from "@vite-hub/agent"
import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { Plugin } from "vite"
import type { ConsoleInvocationRootState } from "../src/console/vite.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import { allowed, consoleAccess } from "./support/console-access.ts"
import { hostManagedAuthorize, productionConsole } from "./support/console-authorize.ts"
import { consoleEvent } from "./console-event.ts"
import { generatedModules } from "../src/internal/generated-modules.ts"

// The libSQL driver that the generated plugin passes outside a Cloudflare production build.
const libsql = async () => await import("../src/internal/agent-invocations-libsql.ts")

const invocationHandler = allowed(invocationHandlerRoute)
const agentInvocationsHandler = allowed(agentInvocationsHandlerRoute)
const usageHandler = allowed(usageHandlerRoute)

const scope = globalThis as ConsoleInvocationScope
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This test double only needs identity; no journal method is invoked through it.
const fakeInvocations = (name: string) => ({ name }) as unknown as AgentInvocations

function isPluginHookObject(value: unknown): value is { handler: unknown } {
  return value !== null && typeof value === "object" && "handler" in value
}

/** Add the Vite logger that resolved-config hooks use for build warnings. */
function withViteLogger<T extends object>(config: T): T & { logger: { warn: () => void } } {
  return Object.assign(config, { logger: { warn: () => undefined } })
}

function callPluginHook(hook: unknown, context: unknown, args: readonly unknown[] = []): unknown {
  const candidate = typeof hook === "function"
    ? hook
    : isPluginHookObject(hook)
      ? hook.handler
      : undefined
  if (typeof candidate !== "function") throw new TypeError("Expected a callable Vite plugin hook.")
  return Reflect.apply(candidate, context, args)
}

/** A test event whose URL and Node response a test can change between calls. */
interface MutableTestEvent extends ConsoleRequestEvent {
  req: { url: string }
}

/** A Console request event at `http://localhost/_vitehub`. Each read of its Standard Context uses the current `req.url`. */
function event(address: string | undefined, method = "GET"): MutableTestEvent {
  const url = "http://localhost/_vitehub"
  const headers = new Headers()
  const target: Omit<MutableTestEvent, "~standard"> = { req: { url } }
  return Object.defineProperty(target, "~standard", {
    get: () => ({
      vendor: "test",
      req: new Request(target.req.url, { method }),
      res: { headers },
      runtime: address ? { clientAddress: address } : {},
    }),
  }) as MutableTestEvent
}

function runtime(runId: string): AgentRuntimeContext {
  return {
    memo: vi.fn(),
    run: { runId },
    runtime: "unknown",
    waitUntil: vi.fn(),
  }
}

/** Installs the default Agent journal, as the generated server does with the Console on or off, and lets the Console read it. */
function installDefaultJournal(projectRoot: string, setting?: AgentInvocationsDefault): AgentInvocations {
  installAgentInvocations({ default: setting, journal: { libsql, projectRoot } })
  return installConsoleInvocations(projectRoot)
}

afterEach(() => {
  installAgentInvocations({})
  Reflect.deleteProperty(globalThis, consoleStateKey)
  delete scope[consoleInvocationsKey]
  delete scope[consoleInvocationsIdentityKey]
  delete scope[consoleInvocationsIdentityRootKey]
  delete scope[consoleInvocationsBindingKey]
  delete scope[consoleInvocationsRootKey]
  Reflect.deleteProperty(process, consoleInvocationsKey)
  Reflect.deleteProperty(process, consoleInvocationsIdentityKey)
  Reflect.deleteProperty(process, consoleInvocationsIdentityRootKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsBindingRootRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRootKey)
  Reflect.deleteProperty(process, consoleInvocationsKey)
  Reflect.deleteProperty(process, consoleProjectRootKey)
  Reflect.deleteProperty(process, consoleInvocationsRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRootIdentityRegistryKey)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The hosted Console link of an invocation, as `consoleInvocationUrl()` builds it. */
function hostedInvocationUrl(project: string, agentSegment: string, id: string): string {
  return `https://console.vitehub.dev/open?project=${encodeURIComponent(project)}&path=${encodeURIComponent(`/agents/${agentSegment}/invocations/${encodeURIComponent(id)}`)}`
}

/** The generated Console Nitro plugin. The CORS preflight plugin can come before it. */
function consolePluginFile(plugins: readonly string[] | undefined): string {
  return plugins?.find(plugin => /\/console\/plugin(?:-[\w-]+)?\.mjs$/.test(plugin)) ?? ""
}

describe("Agent invocation console", () => {
  it("serializes generated Agent registry refreshes", async () => {
    const releases: Array<() => void> = []
    const started: number[] = []
    const refresh = serializeConsoleRefresh(async () => {
      started.push(started.length)
      await new Promise<void>(resolve => releases.push(resolve))
    })

    const first = refresh()
    const second = refresh()
    await vi.waitFor(() => expect(started).toEqual([0]))
    releases.shift()?.()
    await vi.waitFor(() => expect(started).toEqual([0, 1]))
    releases.shift()?.()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it("registers the Console endpoint and invocation API with Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-host-"))
    try {
      await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "console-host" })}\n`)
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default", "archive"],
        console: productionConsole,
        sections: ["agents", "usage", "blob", "kv"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: {
          handlers: Array<{ handler: string, route: string }>
          plugins: string[]
          publicAssets: Array<{ baseURL: string, dir: string }>
        }
        root: string
      } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      if (!config.nitro) throw new TypeError("Expected the console Nitro configuration.")

      expect(config.nitro.handlers.map((handler) => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      expect(config.nitro.publicAssets).toEqual([
        expect.objectContaining({ baseURL: "/_vitehub/.well-known/skills", dir: expect.stringContaining("public/skills"), fallthrough: false }),
        expect.objectContaining({ baseURL: "/_vitehub/console/assets", dir: expect.stringMatching(/runtime\/page-tool$/) }),
        expect.objectContaining({ baseURL: "/_vitehub/page/assets", dir: expect.stringMatching(/runtime\/page$/) }),
      ])
      expect(config.nitro.plugins).toContain(resolve(root, ".vitehub/nitro/console/plugin.mjs"))
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(`installConsoleSections(${JSON.stringify(root)}, ["agents","usage","blob","kv"])`)
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(`installConsoleProjectName(${JSON.stringify(root)}, "console-host")`)
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(
        `installConsoleAgentDefinitions([`,
      )
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(
        `{ projectRoot: ${JSON.stringify(root)} }`,
      )
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(
        `fallbackName: "review"`,
      )
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(
        `installConsoleBlob(${JSON.stringify(root)}, vitehubConsoleBlob, ["default","archive"])`,
      )
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.not.toContain("installConsoleKV")
      await expect(readFile(consolePluginFile(config.nitro.plugins), "utf8")).resolves.toContain(`from "file://`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not enable Database inspection from an inherited Vite config key", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-inherited-database-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: [],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config = Object.assign(Object.create({ database: true }), { root }) as {
        nitro?: { plugins: string[] }
        root: string
      }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).not.toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv","databases"])`)
      expect(generated).not.toContain("installConsoleDatabase(")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not use an inherited Database project root for enabled inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-inherited-database-root-"))
    const inheritedRoot = join(root, "inherited")
    try {
      await mkdir(join(inheritedRoot, "server/databases"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(inheritedRoot, "server/databases/default.ts"), "export default defineDatabase({ schema: {} })\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: ["databases"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config = Object.assign(Object.create({ database: { projectRoot: inheritedRoot } }), { root }) as {
        nitro?: { plugins: string[] }
        root: string
      }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      // Without its own Database Definition, the app gets only the implicit default Database.
      expect(generated).toContain('"name":"default","source":"implicit-default"')
      expect(generated).not.toContain("inherited/server/databases/default.ts")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers the configured Agent runtime capabilities for Console invocations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-agent-capabilities-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        runtimeCapabilityImports: {
          blob: "vite-hub/blob",
          console: "vite-hub/console/server",
          db: "vite-hub/database/drizzle",
          i18n: "vite-hub/i18n/server",
          kv: "vite-hub/kv",
        },
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { plugins: string[] }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      // The capabilities load with the first Console invocation, not when the server starts.
      expect(generated).not.toMatch(/^import .*vite-hub\/(?:blob|database\/drizzle|i18n\/server|kv)/m)
      expect(generated).toContain(`capabilities: async () => { const [{ blob: vitehubConsoleAgentBlob }, { console: vitehubConsoleAgentConsole }, { agentDb: vitehubConsoleAgentDb }, { agentI18n: vitehubConsoleAgentI18n }, { kv: vitehubConsoleAgentKv }] = await Promise.all([import("vite-hub/blob"), import("vite-hub/console/server"), import("vite-hub/database/drizzle"), import("vite-hub/i18n/server"), import("vite-hub/kv")]); return { blob: vitehubConsoleAgentBlob, console: vitehubConsoleAgentConsole, db: vitehubConsoleAgentDb, i18n: vitehubConsoleAgentI18n, kv: vitehubConsoleAgentKv } }`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { base: "/portal/", mount: "/portal" },
    { base: "/portal/", nitro: { baseURL: "/portal/", handlers: [], plugins: [], publicAssets: [] }, mount: "" },
    { base: "https://cdn.example/portal/", mount: "" },
    { base: "https://cdn.example/assets/", __vitehubAppBaseURL: "/portal/", mount: "/portal" },
  ])("mounts Nitro Console routes and assets at the application base: %j", async ({ mount, ...bases }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-base-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: productionConsole, sections: ["agents", "usage"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { base: string, nitro?: { handlers: Array<{ handler: string, route: string }>, plugins: string[], publicAssets: Array<{ baseURL: string, dir: string }> }, root: string } = { ...bases, root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        `${mount}/_vitehub/rpc`,
        `${mount}/_vitehub/page/session`,
      ])
      expect(config.nitro?.publicAssets).toEqual([
        expect.objectContaining({ baseURL: `${mount}/_vitehub/.well-known/skills`, dir: expect.stringContaining("public/skills"), fallthrough: false }),
        expect.objectContaining({ baseURL: `${mount}/_vitehub/console/assets` }),
        expect.objectContaining({ baseURL: `${mount}/_vitehub/page/assets` }),
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("remounts every Console route when Vite resolves a later base path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-base-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: productionConsole, sections: ["agents", "usage"] })
      const configHook = plugin.config
      const configResolvedHook = plugin.configResolved
      if (!configHook || !configResolvedHook) throw new TypeError("Expected Console Vite hooks.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const configResolvedHandler = "handler" in configResolvedHook ? configResolvedHook.handler : configResolvedHook
      const config: { base: string, nitro?: { handlers: Array<{ handler: string, route: string }>, plugins: string[], publicAssets: Array<{ baseURL: string, dir: string }> }, root: string, vitehubCliDiscovery: true } = { base: "/early/", root, vitehubCliDiscovery: true }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      config.nitro?.publicAssets.push({ baseURL: "/portal/_vitehub/assets", dir: "/user-owned-assets" })

      const resolvedConfig = { ...config, base: "/portal/", logger: { warn: () => undefined } }
      await Reflect.apply(configResolvedHandler, {}, [resolvedConfig])

      expect(resolvedConfig.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/portal/_vitehub/rpc",
        "/portal/_vitehub/page/session",
      ])
      // The app keeps its own assets below /_vitehub. No Console assets remain at the earlier base.
      expect(resolvedConfig.nitro?.publicAssets).toEqual([
        expect.objectContaining({ baseURL: "/portal/_vitehub/.well-known/skills", dir: expect.stringContaining("public/skills") }),
        { baseURL: "/portal/_vitehub/assets", dir: "/user-owned-assets" },
        expect.objectContaining({ baseURL: "/portal/_vitehub/console/assets" }),
        expect.objectContaining({ baseURL: "/portal/_vitehub/page/assets" }),
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("starts development Setup without a Console client package", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-setup-client-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ rpcOnly: true, sections: [] })
      const config = { root, nitro: { handlers: [], plugins: [], publicAssets: [] } }
      await callPluginHook(plugin.config, {}, [config, { command: "serve", mode: "development" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger({ ...config, base: "/" })])

      const file = config.nitro.plugins.find((file: string) => file.endsWith("/console/plugin.mjs"))
      expect(file).toBeDefined()
      const generated = await readFile(file!, "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["setup","kv"], ["setup"])`)
      expect(generated).toContain(`true, "/__vitehub/setup")`)
      expect(generated).not.toContain("installConsoleClient(")
      expect(config.nitro.handlers).not.toContainEqual(expect.objectContaining({ handler: expect.stringContaining("server/page.get.js") }))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(["open", "signed", "rpc-only"] as const)("leaves application OAuth discovery routes alone with %s Console access", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-discovery-"))
    try {
      const applicationHandlers = [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/**",
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/**",
      ].map((route, index) => ({ handler: `/application/discovery-${index}.js`, route }))
      const plugin = consoleVitePlugin({
        console: mode === "rpc-only" ? undefined : mode === "open" ? { auth: false } : {},
        rpcOnly: mode === "rpc-only",
      })
      const config = { base: "/early/", root, nitro: { handlers: [...applicationHandlers] }, vitehubCliDiscovery: true }
      await callPluginHook(plugin.config, {}, [config, { command: mode === "rpc-only" ? "serve" : "build", mode: "production" }])
      const resolved = { ...config, base: "/portal/" }
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(resolved)])

      expect(resolved.nitro.handlers.filter(handler => handler.route?.startsWith("/.well-known/"))).toEqual(applicationHandlers)
      expect(resolved.nitro.handlers.map(handler => handler.route).filter(route => !route?.startsWith("/.well-known/"))).toEqual(mode === "rpc-only" ? ["/portal/_vitehub/rpc"] : ["/portal/_vitehub/rpc", "/portal/_vitehub/page/session"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("remounts Console RPC routes when a later Vite base replaces the early base", () => {
    const config: { handlers: Array<{ handler: string, route: string }> } = { handlers: [] }
    addConsoleRpcHandler(config, "/runtime", "/early/")
    addConsoleRpcHandler(config, "/runtime", "/portal/")

    expect(config.handlers.map(handler => handler.route)).toEqual(["/portal/_vitehub/rpc"])
  })

  it("registers Blob inspection without loading the Agent server graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-blob-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default", "archive"],
        console: productionConsole,
        resolveKV: () => false,
        sections: ["env", "blob"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleBlob)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(
        `installConsoleBlob(${JSON.stringify(root)}, vitehubConsoleBlob, ["default","archive"])`,
      )
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps an application Blob route beside the standalone Console RPC route", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-blob-conflict-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        blobStores: ["default"],
        console: productionConsole,
        resolveKV: () => false,
        sections: ["blob"],
      })
      const config = {
        nitro: {
          handlers: [{ handler: "~/server/api/blob.ts", route: "/_vitehub/api/blob" }],
        },
        root,
      }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro.handlers).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/_vitehub/api/blob" }),
        expect.objectContaining({ route: "/_vitehub/rpc" }),
      ]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("registers only the section manifest and pages for a KV-only console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-kv-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "hidden.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: ["kv"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map((handler) => handler.route)).toEqual(["/_vitehub/rpc", "/_vitehub/page/session"])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["kv"])`)
      expect(generated).not.toContain("installConsoleInvocations")
      expect(generated).not.toContain("installConsoleKV")
      expect(generated).not.toContain("hidden.agent")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    ["node", "before", true],
    ["node", "after", true],
    ["cloudflare", "before", true],
    ["cloudflare", "after", true],
    ["cloudflare", "after", false],
  ] as const)("uses standalone KV for sealed MCP storage on %s, ordered %s, enabled %s", async (preset, order, enabled) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-standalone-kv-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugins = vitehub({
        console: { ...productionConsole, mcpClient: true },
        env: false,
        preset,
      })
      // SAFETY: Vite plugin options form a recursive array; narrow the flattened candidates by name.
      const candidates = (plugins as unknown[]).flat(Infinity)
      const plugin = candidates.find((candidate): candidate is Plugin => Boolean(candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/console"))
      if (!plugin) throw new TypeError("Expected the ViteHub Console plugin.")
      const kvPlugin = hubKv(enabled ? { driver: preset === "cloudflare" ? "cloudflare-kv-binding" : "fs-lite" } : false)
      const configuredPlugins: unknown[] = [kvPlugin]
      if (order === "before") configuredPlugins.push(plugin)
      else configuredPlugins.unshift(plugin)
      const config = {
        root,
        plugins: configuredPlugins,
      }
      await callPluginHook(kvPlugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(kvPlugin.configResolved, {}, [config])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      const sections = generated.match(/installConsoleSections\([^,\n]+, (\[[^\n]*?\])\)/)?.[1]
      expect(sections).toBeDefined()
      expect(JSON.parse(sections!)).toContain("mcp-client")
      expect(JSON.parse(sections!).includes("kv")).toBe(enabled)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("disables Queue inspection from the framework handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-queue-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["queues"],
      })
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        queue?: boolean
        root: string
      } = { queue: true, root }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/_vitehub/rpc")
      setResolvedFeatureOptions(config, "queue", false)
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      expect(config.nitro?.handlers.map(handler => handler.route)).toContain("/_vitehub/rpc")
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).not.toContain("installConsoleDefinitions")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses configured server directories during resolved Workflow discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-workflow-server-dirs-"))
    try {
      const customServerDir = join(root, "backend")
      await writeFile(join(root, "package.json"), "{}\n")
      await mkdir(join(root, "server", "workflows", "welcome"), { recursive: true })
      await writeFile(join(root, "server", "workflows", "welcome.ts"), "export default null\n")
      await writeFile(join(root, "server", "workflows", "welcome", "01.step.ts"), "export default null\n")
      await mkdir(join(customServerDir, "workflows"), { recursive: true })
      await writeFile(join(customServerDir, "workflows", "custom.ts"), "export default null\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: ["workflows"],
      })
      const config = {
        [VITEHUB_SERVER_DIRS]: [customServerDir],
        root,
        workflow: true,
      }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('"name":"custom"')
      expect(generated).not.toContain('"name":"welcome"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Workspace Definition metadata without initializing stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-workspace-host-"))
    try {
      await mkdir(join(root, "server/workspaces/docs/workspace"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/workspaces/docs/config.ts"),
        `export default defineWorkspace({ store: { provider: "memory" } })\nthrow new Error("The Console must not initialize Workspace Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["workspaces"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }>; plugins: string[] }; root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["workspaces"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"workspaces":{"definitions":[{"fields":[{"label":"Kind","value":"Workspace Definition"},{"label":"Source root","value":"server/workspaces/docs/workspace"}],"file":"server/workspaces/docs/config.ts","name":"docs","source":"server-workspaces-directory-config"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not initialize")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Database Definition metadata without loading schemas", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-database-host-"))
    try {
      await mkdir(join(root, "server/databases"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/databases/default.ts"),
        `export default defineDatabase({ schema: { notes, users } })\nthrow new Error("The Console must not evaluate Database Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["env", "databases"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDatabase)})`)
      expect(generated).toContain(`import("vite-hub/database/drizzle")`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["env","databases"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"databases":{"definitions":[{"fields":[{"label":"Mode","value":"Default"},{"label":"Tables","value":"notes, users"}],"file":"server/databases/default.ts","name":"default","source":"server-databases"}],"kind":"definition-catalog"}}, `)
      expect(generated).toContain(`installConsoleDatabase(${JSON.stringify(root)}, vitehubConsoleDatabases, ["default"])`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Queue Definition metadata without loading handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-queue-host-"))
    try {
      await mkdir(join(root, "server/queues"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/queues/email.ts"),
        `throw new Error("The Console must not evaluate Queue Definitions during discovery.")\n`,
      )
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["env", "queues"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["env","queues"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"queues":{"definitions":[{"fields":[],"file":"server/queues/email.ts","name":"email","source":"server-queues"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serializes discovered Rate Limit policies without loading application modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rate-limit-host-"))
    try {
      await mkdir(join(root, "server/api"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/api/upload.post.ts"),
        [
          'import { requireRateLimit } from "vite-hub/rate-limit"',
          'requireRateLimit(event, "uploads", { enforcement: "strict", failure: "allow", limit: 25, window: "10s" })',
          'throw new Error("The Console must not evaluate Rate Limit modules during discovery.")',
          "",
        ].join("\n"),
      )
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["env", "rate-limits"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["env","rate-limits"])`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"rate-limits":{"definitions":[{"fields":[{"label":"Limit","value":"25"},{"label":"Window","value":"10s"},{"label":"Enforcement","value":"Strict"},{"label":"Provider failure","value":"Allow"},{"label":"Source location","value":"2:1"}],"file":"server/api/upload.post.ts","name":"uploads","source":"require-rate-limit"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("does not scan host server directories for default Rate Limit discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-rate-limit-server-dirs-"))
    const hostServerDir = await mkdtemp(join(tmpdir(), "vitehub-host-server-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(hostServerDir, "upload.ts"), 'requireRateLimit(event, "uploads", { limit: 25, window: "10s" })\n')
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["rate-limits"],
      })
      const config: {
        [VITEHUB_SERVER_DIRS]: string[]
        nitro?: { plugins: string[] }
        root: string
      } = {
        [VITEHUB_SERVER_DIRS]: [hostServerDir],
        root,
      }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"rate-limits":{"definitions":[],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain('"name":"uploads"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(hostServerDir, { force: true, recursive: true })
    }
  })

  it("serializes discovered Schedule timing metadata without loading handlers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-schedule-host-"))
    try {
      await mkdir(join(root, "server/schedules"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(
        join(root, "server/schedules/daily.ts"),
        `export default defineSchedule({ cron: "0 0 1 * 1", manual: true, handler() { throw new Error("The Console must not evaluate Schedule Definitions during discovery.") } })\n`,
      )
      await writeFile(
        join(root, "server/schedules/dynamic.ts"),
        `const scheduleCron = process.env.SCHEDULE_CRON || "0 10 * * *"\nexport default defineSchedule({ cron: scheduleCron, handler() {} })\n`,
      )
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["schedules"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: {
        nitro?: { handlers: Array<{ route: string }>; plugins: string[] }
        root: string
      } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])

      expect(config.nitro?.handlers.map(handler => handler.route)).toEqual([
        "/_vitehub/rpc",
        "/_vitehub/page/session",
      ])
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleSections(${JSON.stringify(root)}, ["schedules"])`)
      // The runtime reader reads the Definitions that the Process Runtime loaded. It does not import a handler itself.
      expect(generated).toContain(`{ readScheduleConsoleRecords: vitehubConsoleRuntimeReader0 }`)
      expect(generated).toMatch(/import\("[^"]*[\\/]schedule[\\/](?:src|dist)[\\/]runtime[\\/]console\.(?:ts|js)"\)/)
      expect(generated).not.toContain("() => import(")
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"schedules":{"kind":"record-table","records":[{"cells":{"manual":"Enabled","schedule":"daily","timing":"0 0 1 * 1"},"fields":[{"label":"Kind","value":"Static schedule"},{"label":"Cron","value":"0 0 1 * 1"},{"label":"Time zone","value":"UTC"},{"label":"Manual","value":"Enabled"},{"label":"File","value":"server/schedules/daily.ts"},{"label":"Source","value":"server-schedules"},`)
      expect(generated).toContain(`{"label":"File","value":"server/schedules/dynamic.ts"},{"label":"Source","value":"server-schedules"}`)
      expect(generated).not.toContain(`"Cron","value":"0 10 * * *"`)
      expect(generated).not.toContain("The Console must not evaluate")
      expect(generated).not.toContain("installConsoleInvocations")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("discovers definitions from each service project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-service-roots-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await mkdir(join(root, "packages/database/server/databases"), { recursive: true })
      await mkdir(join(root, "packages/rate-limit/policies"), { recursive: true })
      await mkdir(join(root, "packages/workspace/server/workspaces/docs/workspace"), { recursive: true })
      await mkdir(join(root, "packages/schedule/server/schedules"), { recursive: true })
      await writeFile(join(root, "packages/database/server/databases/default.ts"), "export default defineDatabase({ schema: {} })\n")
      await writeFile(join(root, "packages/rate-limit/policies/api.ts"), 'requireRateLimit(event, "api", { limit: 100, window: "1m" })\n')
      await writeFile(join(root, "packages/workspace/server/workspaces/docs/config.ts"), "export default defineWorkspace({ store: { provider: 'memory' } })\n")
      await writeFile(join(root, "packages/schedule/server/schedules/adhoc.ts"), "export default defineSchedule({ cron: \"0 9 * * *\", handler() {} })\n")
      const plugins = vitehub({
        console: productionConsole,
        database: { projectRoot: "packages/database" },
        preset: "cloudflare",
        rateLimit: { projectRoot: "packages/rate-limit", scanDirs: ["policies"] },
        schedule: { projectRoot: "packages/schedule" },
        workspace: { projectRoot: "packages/workspace" },
      })
      // SAFETY: Vite plugin options form a recursive array, and this test narrows each flattened candidate structurally before using it as a plugin.
      const pluginCandidates = (plugins as unknown[]).flat(Infinity)
      const plugin = pluginCandidates.find((candidate): candidate is Plugin => Boolean(candidate && typeof candidate === "object" && "name" in candidate && candidate.name === "vite-hub/console"))
      if (!plugin) throw new TypeError("Expected the ViteHub Console plugin.")

      await callPluginHook(plugin.config, {}, [{ root }, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger({ root })])

      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('"databases":{"definitions":[{"fields":[{"label":"Mode","value":"Default"},{"label":"Tables","value":"None discovered"}],"file":"packages/database/server/databases/default.ts"')
      expect(generated).toContain('"rate-limits":{"definitions":[{"fields":[{"label":"Limit","value":"100"},{"label":"Window","value":"1m"}')
      expect(generated).toContain('"file":"packages/rate-limit/policies/api.ts","name":"api","source":"require-rate-limit"')
      expect(generated).toContain('"workspaces":{"definitions":[{"fields":[{"label":"Kind","value":"Workspace Definition"}')
      expect(generated).toContain('"file":"packages/workspace/server/workspaces/docs/config.ts","name":"docs"')
      expect(generated).toContain('"schedules":{"kind":"record-table","records":[{"cells":{"manual":"Disabled","schedule":"adhoc","timing":"0 9 * * *"}')
      expect(generated).toContain('{"label":"File","value":"packages/schedule/server/schedules/adhoc.ts"}')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses the framework Database root when it replaces a configured service root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-database-override-"))
    const viteRoot = join(projectRoot, "app")
    try {
      await mkdir(join(projectRoot, "packages/api/server/databases"), { recursive: true })
      await mkdir(join(viteRoot, "server/databases"), { recursive: true })
      await writeFile(join(projectRoot, "package.json"), "{}\n")
      await writeFile(join(projectRoot, "packages/api/server/databases/default.ts"), "export default defineDatabase({ schema: {} })\n")
      await writeFile(join(viteRoot, "server/databases/default.ts"), "export default defineDatabase({ schema: {} })\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        databaseDiscoveryRoot: "packages/api",
        resolveKV: () => false,
        sections: ["databases"],
      })
      const config: { database?: object; nitro?: { plugins: string[] }; root: string } = { root: viteRoot }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      setResolvedFeatureOptions(config, "database", { projectRoot: viteRoot })
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain('"file":"app/server/databases/default.ts"')
      expect(generated).not.toContain('"file":"packages/api/server/databases/default.ts"')
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("uses each runtime's default discovery root in a nested Vite app", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-resolved-root-"))
    const viteRoot = join(projectRoot, "app")
    try {
      await mkdir(join(projectRoot, "server/schedules"), { recursive: true })
      await mkdir(join(projectRoot, "src"), { recursive: true })
      await mkdir(join(viteRoot, "src"), { recursive: true })
      await writeFile(join(projectRoot, "package.json"), "{}\n")
      await writeFile(join(projectRoot, "src/api.ts"), 'requireRateLimit(event, "api", { limit: 100, window: "1m" })\n')
      await writeFile(join(projectRoot, "src/unrelated.sandbox-task.ts"), "export default defineSandboxTask({ handler: async () => undefined })\n")
      await writeFile(join(viteRoot, "src/preview.sandbox-task.ts"), "export default defineSandboxTask({ handler: async () => undefined })\n")
      await writeFile(join(projectRoot, "server/schedules/adhoc.ts"), "export default defineSchedule({ cron: \"0 9 * * *\", handler() {} })\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["rate-limits", "sandbox-tasks", "schedules"],
      })
      const config: { nitro?: { plugins: string[] }; root: string } = { root: viteRoot }

      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      expect(config.nitro?.plugins).toContain(join(projectRoot, ".vitehub/nitro/console/plugin.mjs"))
      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(projectRoot)}`)
      expect(generated).toContain(`"file":"src/api.ts","name":"api","source":"require-rate-limit"`)
      expect(generated).toContain(`"file":"app/src/preview.sandbox-task.ts","name":"preview","source":"vite-suffix"`)
      expect(generated).not.toContain(`"name":"unrelated"`)
      expect(generated).toContain(`{"label":"File","value":"server/schedules/adhoc.ts"},{"label":"Source","value":"server-schedules"}`)
      expect(generated).not.toContain(`"file":"../`)
      expect(generated).not.toContain(`{"label":"File","value":"../`)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("serializes discovered Sandbox Task Definition metadata without starting a Sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-sandbox-host-"))
    try {
      await mkdir(join(root, "src"), { recursive: true })
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "src/preview.sandbox-task.ts"), `export default defineSandboxTask({ handler: async () => { throw new Error("must not run") } })\n`)
      const plugin = consoleVitePlugin({
        console: productionConsole,
        resolveKV: () => false,
        sections: ["sandbox-tasks"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }>; plugins: string[] }; root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      await callPluginHook(plugin.configResolved, {}, [withViteLogger(config)])

      const generated = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      expect(generated).toContain(`from ${JSON.stringify(generatedModules.consoleSetup)}`)
      expect(generated).toContain(`import(${JSON.stringify(generatedModules.consoleDefinitions)})`)
      expect(generated).not.toContain(`from "vite-hub/console/server"`)
      expect(generated).toContain(`installConsoleDefinitions(${JSON.stringify(root)}, {"sandbox-tasks":{"definitions":[{"fields":[{"label":"Kind","value":"Definition"}],"file":"src/preview.sandbox-task.ts","name":"preview","source":"vite-suffix"}],"kind":"definition-catalog"}}, `)
      expect(generated).not.toContain("must not run")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects host-managed production Console builds on non-Node hosts", async () => {
    const plugin = consoleVitePlugin({ console: { auth: false, authorize: hostManagedAuthorize }, sections: ["agents"] })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a console config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook

    await expect(Reflect.apply(configHandler, {}, [{ root: process.cwd() }, {
      command: "build",
      mode: "production",
    }])).rejects.toMatchObject({ code: "VITE_HUB_B0022" })
  })

  it("rejects a production build with no Console sign-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-open-build-"))
    try {
      for (const consoleOptions of [{ auth: false }, { auth: false, authorize: hostManagedAuthorize }] as const) {
        const plugin = consoleVitePlugin({ console: consoleOptions })
        const config = { root }
        await expect(callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }]))
          .rejects.toMatchObject({ code: "VITE_HUB_B0022", message: expect.stringContaining("console.auth false is for development. Remove console.auth so the app takes only signed calls") })
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { command: "build", invoke: undefined, enabled: false },
    { command: "build", invoke: false, enabled: false },
    { command: "build", invoke: true, enabled: true },
    { command: "serve", invoke: undefined, enabled: true },
    { command: "serve", invoke: false, enabled: false },
  ] as const)("uses invoke $invoke with $command", async ({ command, enabled, invoke }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-host-invoke-"))
    try {
      const plugin = consoleVitePlugin({
        console: { ...productionConsole, invoke },
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      await Reflect.apply(configHandler, {}, [{ root }, { command, mode: command === "build" ? "production" : "development" }])
      const generated = await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated.includes("invoke: true")).toBe(enabled)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("adds the Auth section and its impersonation route for app Auth, with no Auth policy for the Console", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-host-"))
    const auth: ResolvedAuthViteConfig = {
      access: { routes: [] },
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
      rootDir: root,
      route: "/api/auth",
      secondaryStorage: false,
      tables: false,
    }
    try {
      const plugin = consoleVitePlugin({ console: { invoke: true }, resolveAuthConfig: () => auth, sections: ["agents"] })
      const config: { nitro?: { handlers: Array<{ route: string }> }; root: string } = { root }
      await callPluginHook(plugin.config, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toEqual([
        // App Auth access routes leave a request that Nitro routes to the Console RPC to its own check: a signed POST
        // or a one-time ticket GET.
        expect.objectContaining({ route: "/_vitehub/rpc", meta: { vitehubAuthAccess: "handler" } }),
        // The page tools session of the Console link. It reads no Console data.
        { handler: expect.stringMatching(/server\/page-session\.js$/), route: "/_vitehub/page/session" },
      ])
      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated).toContain('installConsoleAccess({ mode: "token" })')
      expect(generated).toContain(`installConsoleAgentDefinitions([], { projectRoot: ${JSON.stringify(root)}, invoke: true })`)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("accepts explicit host-managed production exposure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-managed-host-"))
    try {
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/rpc" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps the local console available during development for every preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-dev-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ console: { auth: false } })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "serve", mode: "development" }])

      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/rpc" }))
      expect(config.nitro?.handlers).not.toContainEqual(expect.objectContaining({ route: "/_vitehub" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("serves discovered Agent names in stable order for the active project", async () => {
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(first, "/first")
    installConsoleAgents(["support", "review", "support"], first)
    installConsoleInvocationFallback(second, "/second")
    installConsoleAgents(["billing"], second)

    await expect(listConsoleAgents()).resolves.toEqual({
      agents: ["billing"],
      invocationAgents: [],
    })

    scope[consoleProjectRootKey] = "/first"
    await expect(listConsoleAgents()).resolves.toEqual({
      agents: ["review", "support"],
      invocationAgents: [],
    })
  })

  it("serves Agent names without paging through invocation summaries", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({
      agentName: "archived",
      createdAt: "2026-08-31T00:00:00.000Z",
      id: "archived",
      observations: [],
      status: "completed",
      traceId: "archived-trace",
      updatedAt: "2026-08-31T00:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents(["current"], invocations)
    store.list = vi.fn(() => {
      throw new Error("The Console should use the distinct Agent-name index.")
    })

    await expect(listConsoleAgents()).resolves.toEqual({
      agents: ["current"],
      invocationAgents: ["archived"],
    })
    expect(store.list).not.toHaveBeenCalled()
  })

  it("keeps persisted names in invocation history when they match a registered Agent", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const agentName of ["archived", "current"]) {
      await store.create({
        agentName,
        createdAt: "2026-08-31T00:00:00.000Z",
        id: agentName,
        observations: [],
        status: "completed",
        traceId: `${agentName}-trace`,
        updatedAt: "2026-08-31T00:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents(["current"], invocations)

    await expect(listConsoleAgents()).resolves.toEqual({
      agents: ["current"],
      invocationAgents: ["archived", "current"],
    })
  })

  it("serves the Console sections and project name that generated output installed last", async () => {
    installConsoleSections("/project", ["agents"])
    installConsoleProjectName("/project", "first-app")
    installConsoleSections("/project", ["kv", "kv"])
    installConsoleProjectName("/project", "second-app")

    expect(await listConsoleSections(await consoleAccess(event("127.0.0.1")))).toEqual({
      projectName: "second-app",
      sections: ["kv"],
    })
  })

  it("does not let section registration rebind the invocation project", async () => {
    const first = fakeInvocations("first")
    installConsoleInvocationFallback(first, "/first")

    installConsoleSections("/second", ["kv"])

    expect(resolveConsoleProjectRoot()).toBe("/first")
    expect(resolveConsoleInvocations()).toBe(first)
    expect(await listConsoleSections(await consoleAccess(event("127.0.0.1")))).toEqual({ sections: ["kv"] })
  })

  it("keeps configured identities across concurrent same-root runtimes", async () => {
    const projectRoot = "/project"
    const firstIdentity = "runtime:/project:first"
    const secondIdentity = "runtime:/project:second"
    const thirdIdentity = "runtime:/project:third"
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const third = fakeInvocations("third")
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity)
    const firstState = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(firstState, projectRoot, firstIdentity)
    const firstPlugin = consoleInvocationRootPlugin(projectRoot, firstIdentity, firstState)
    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity)
    const secondState = { identity: secondIdentity, projectRoot }
    updateConsoleInvocationRootState(secondState, projectRoot, secondIdentity)
    const secondPlugin = consoleInvocationRootPlugin(projectRoot, secondIdentity, secondState)
    const resolved = { id: "/agent.ts" }
    await callPluginHook(firstPlugin.buildStart, { resolve: vi.fn().mockResolvedValue(resolved) })
    await callPluginHook(secondPlugin.buildStart, { resolve: vi.fn().mockResolvedValue(resolved) })

    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const firstRealm = runInNewContext(`${callPluginHook(firstPlugin.transform, {}, ["", resolved.id])}\nglobalThis`, { process }) as object
    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const secondRealm = runInNewContext(`${callPluginHook(secondPlugin.transform, {}, ["", resolved.id])}\nglobalThis`, { process }) as object

    expect(resolveConsoleInvocations(firstRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)

    installConsoleInvocationFallback(third, projectRoot, globalThis, thirdIdentity)
    updateConsoleInvocationRootState(firstState, projectRoot, thirdIdentity)

    expect(resolveConsoleInvocations(firstRealm)).toBe(third)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(firstIdentity)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(true)

    await callPluginHook(secondPlugin.closeBundle, {})
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(false)
  })

  it("retires the current journal when its only runtime closes", async () => {
    const projectRoot = "/project"
    const identity = "runtime:/project"
    const invocations = fakeInvocations("fixture")
    installConsoleInvocationFallback(invocations, projectRoot, globalThis, identity)
    const state = { identity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, identity)
    const plugin = consoleInvocationRootPlugin(projectRoot, identity, state)

    await callPluginHook(plugin.closeBundle, {})

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).has(projectRoot)).toBe(false)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(false)
    expect(Reflect.has(process, consoleInvocationsKey)).toBe(false)
    expect(resolveConsoleInvocations()).toBeUndefined()
    expect(scope[consoleInvocationsRootKey]).toBeUndefined()
    expect(scope[consoleInvocationsIdentityKey]).toBeUndefined()
    expect(scope[consoleInvocationsIdentityRootKey]).toBeUndefined()
  })

  it("keeps a shared runtime binding until its last server environment closes", async () => {
    const projectRoot = "/project"
    const identity = "runtime:/project"
    const invocations = fakeInvocations("fixture")
    installConsoleInvocationFallback(invocations, projectRoot, globalThis, identity)
    const state: ConsoleInvocationRootState = { identity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, identity)
    const plugin = consoleInvocationRootPlugin(projectRoot, identity, state)
    const firstEnvironment = { name: "first" }
    const secondEnvironment = { name: "second" }
    const resolved = { id: "/agent.ts" }
    await callPluginHook(plugin.configEnvironment, {}, [firstEnvironment.name, { consumer: "server" }])
    await callPluginHook(plugin.configEnvironment, {}, [secondEnvironment.name, { consumer: "server" }])
    await callPluginHook(plugin.buildStart, { environment: firstEnvironment, resolve: vi.fn().mockResolvedValue(resolved) })
    await callPluginHook(plugin.buildStart, { environment: secondEnvironment, resolve: vi.fn().mockResolvedValue(resolved) })
    const transformed = callPluginHook(plugin.transform, {}, ["", resolved.id])
    // SAFETY: The generated script returns the isolated realm used by this focused environment-lifecycle test.
    const realm = runInNewContext(`${transformed}\nglobalThis`, { process }) as object

    await callPluginHook(plugin.closeBundle, { environment: firstEnvironment })
    expect(state.closed).toBeUndefined()
    expect(resolveConsoleInvocations(realm)).toBe(invocations)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(true)

    await callPluginHook(plugin.closeBundle, { environment: secondEnvironment })
    expect(state.closed).toBe(true)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(identity)).toBe(false)
  })

  it("restores a surviving same-root runtime when the current runtime closes", async () => {
    const projectRoot = "/project"
    const firstIdentity = "runtime:/project:first"
    const secondIdentity = "runtime:/project:second"
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity)
    const firstState = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(firstState, projectRoot, firstIdentity)
    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity)
    const secondState = { identity: secondIdentity, projectRoot }
    updateConsoleInvocationRootState(secondState, projectRoot, secondIdentity)
    const secondPlugin = consoleInvocationRootPlugin(projectRoot, secondIdentity, secondState)

    await callPluginHook(secondPlugin.closeBundle, {})

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).get(projectRoot)).toBe(firstIdentity)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: projectRoot })).toBe(first)
    expect(resolveConsoleInvocations()).toBe(first)
    expect(Reflect.get(process, consoleInvocationsKey)).toBe(first)
    expect(scope[consoleInvocationsIdentityKey]).toBe(firstIdentity)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(firstIdentity)).toBe(true)
    expect(Reflect.get(process, consoleInvocationsRegistryKey).has(secondIdentity)).toBe(false)
  })

  it("lists persisted Agent names apart from registered Agents", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "archived",
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "archived-invocation",
      observations: [],
      status: "completed",
      traceId: "archived-trace",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents(["current"], invocations)

    await expect(listConsoleAgents()).resolves.toEqual({
      agents: ["current"],
      invocationAgents: ["archived"],
    })
  })

  it("uses explicit Agent Definition names instead of discovered route names", async () => {
    const definition = defineAgent({ driver: { run: () => "ok" }, name: " support " })
    expect(definition.name).toBe("support")
    expect(Object.getOwnPropertyDescriptor(definition, "invocations"))
      .toMatchObject({ enumerable: false, get: expect.any(Function), set: expect.any(Function) })
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations })

    expect(definition.invocations).toBe(invocations)
    await expect(listConsoleAgents()).resolves.toEqual({ agents: ["support"], invocationAgents: [] })
  })

  it("records the discovered name for an unnamed Agent run from server code", async () => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    const labeller = defineAgent({ driver: { run: () => "labelled" }, runtime: false })
    expect(installConsoleAgentDefinitions([
      { definition: { default: labeller }, fallbackName: "labeller" },
    ], { invocations })).toEqual(["labeller"])

    const [error] = await runAgent(labeller, { prompt: "Label this email." })
    expect(error).toBeUndefined()
    const { invocations: records } = await invocations.list({ limit: 10 })
    expect(records).toEqual([expect.objectContaining({ agentName: "labeller", status: "completed" })])
    expect(labeller.name).toBeUndefined()
  })

  it.each([false, true])("leaves aliased Definitions unnamed on direct runs with Skills decorations %s", async (withSkills) => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    const shared = defineAgent({ driver: { run: () => "labelled" }, invocations, runtime: false })
    const decorate = () => withSkills ? agentWithColocatedSkills(shared, {
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": {
        content: btoa("# Review\n"),
        encoding: "base64",
      },
    }) : shared
    const first = decorate()
    const second = decorate()
    installConsoleAgentDefinitions([
      { definition: { default: first }, fallbackName: "first" },
      { definition: { default: second }, fallbackName: "second" },
    ], { invocations })

    const [error] = await runAgent(shared, { prompt: "Label this email." })
    expect(error).toBeUndefined()
    const { invocations: records } = await invocations.list({ limit: 10 })
    expect(records).toEqual([expect.objectContaining({ status: "completed" })])
    expect(records[0]?.agentName).toBeUndefined()
    for (const definition of [first, second]) {
      await runAgentWithContext(definition, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Direct call" })
    }
    const direct = await invocations.list({ limit: 10 })
    expect(direct.invocations).toHaveLength(3)
    expect(direct.invocations.every((record) => record.agentName === undefined)).toBe(true)
    for (const [definition, name] of [[first, "first"], [second, "second"]] as const) {
      await runAgentWithContext(definition, { agentIdentity: { name }, memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Host call" })
      const hosted = await invocations.list({ agentName: name, limit: 10 })
      expect(hosted.invocations).toEqual([expect.objectContaining({ agentName: name, status: "completed" })])
    }
  })

  it.each([false, true])("records the discovered name on the source of a Skills clone with workspace decoration %s", async (withWorkspace) => {
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    const labeller = withWorkspace
      ? defineAgent({ workspace: {}, driver: { run: () => "labelled" } })
      : defineAgent({ driver: { run: () => "labelled" }, runtime: false })
    const skillsClone = agentWithColocatedSkills(labeller, {
      "__vitehubAgentSkill:.agents/skills/review/SKILL.md": {
        content: btoa("# Review\n"),
        encoding: "base64",
      },
    })
    const decorated = withWorkspace ? workspaceAgentWithSourceRoot(skillsClone, process.cwd()) : skillsClone
    if (withWorkspace) expect(decorated).not.toBe(skillsClone)
    expect(installConsoleAgentDefinitions([
      { definition: { default: decorated }, fallbackName: "labeller" },
    ], { invocations })).toEqual(["labeller"])

    await expect(runAgentWithContext(labeller, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, { prompt: "Label this email." })).resolves.toBe("labelled")
    const { invocations: records } = await invocations.list({ limit: 10 })
    expect(records).toEqual([expect.objectContaining({ agentName: "labeller", status: "completed" })])
  })

  it("advertises invokable Agents and their profiles only when invocation is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-invoke-agents-"))
    try {
      const definition = defineAgent({
        driver: { run: () => "ok" },
        invoker: {
          profiles: [
            { id: " support ", kind: "person", label: " Support agent " },
            { id: "automation", kind: "service" },
          ],
        },
        name: "support",
      })
      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { invoke: true, projectRoot: root })

      await expect(listConsoleAgents()).resolves.toEqual({
        agents: ["support"],
        invocationAgents: [],
        invocation: {
          support: {
            profiles: [
              { id: "support", label: "Support agent" },
              { id: "automation" },
            ],
          },
        },
      })

      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { projectRoot: root })
      await expect(listConsoleAgents()).resolves.toEqual({ agents: ["support"], invocationAgents: [] })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each(["support", ".", "team/support"])("starts an enabled Agent invocation for %j", async (name) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-invoke-agent-"))
    try {
      const definition = defineAgent({
        driver: { run: () => "done" },
        invoker: {
          profiles: [{ id: "support", kind: "person", label: "Support agent" }],
        },
        name,
      })
      installAgentInvocations({ journal: { libsql, projectRoot: root } })
      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { invoke: true, projectRoot: root })
      const response = { headers: new Headers() }
      const segment = encodeAgentRouteParam(name)
      const invocation = await agentInvocationsHandler(consoleEvent({
        context: { params: { agent: segment } },
        body: ({ invokerProfileId: "support", prompt: " Test this Agent " }),
        url: `http://localhost/_vitehub/api/agents/${segment}/invocations?agentRoute=encoded`,
        res: response,
      }))

      expect(invocation).toMatchObject({
        agent: name,
        id: expect.any(String),
        url: expect.stringMatching(new RegExp(`^/agents/${segment}/invocations/`)),
      })
      expect(Reflect.get(response, "status")).toBe(202)
      await vi.waitFor(async () => {
        await expect(definition.invocations?.get(invocation.id)).resolves.toMatchObject({
          agentName: name,
          status: "completed",
        })
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    ["team/support", "team%2Fsupport"],
    ["~002e", "~002e"],
  ])("starts an invocation from an existing Console client for %j", async (name, segment) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-legacy-invoke-"))
    try {
      const definition = defineAgent({ driver: { run: () => "done" }, name })
      installAgentInvocations({ journal: { libsql, projectRoot: root } })
      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { invoke: true, projectRoot: root })
      const invocation = await agentInvocationsHandler(consoleEvent({
        context: { params: { agent: segment } },
        body: ({ prompt: "Review" }),
        url: `http://localhost/_vitehub/api/agents/${segment}/invocations`,
      }))
      expect(invocation.agent).toBe(name)
      await vi.waitFor(async () => {
        await expect(definition.invocations?.get(invocation.id)).resolves.toMatchObject({ agentName: name })
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("cancels running invocations only with Console invoke access", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-invocation-cancel-"))
    let release: (value: string) => void = () => {}
    let handlerStarted = false
    const definition = defineAgent({
      driver: { run: () => new Promise<string>((resolve) => {
        release = resolve
        handlerStarted = true
      }) },
      name: "support",
    })
    const detailEvent = (id: string, body?: unknown): ConsoleRequestEvent => {
      const method = body === undefined ? "GET" : "POST"
      const url = `http://localhost/_vitehub/api/invocations/${id}`
      return consoleEvent({ body, method, remoteAddress: "127.0.0.1", url })
    }
    installAgentInvocations({ journal: { libsql, projectRoot: root } })
    const install = (invoke: boolean) => installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invoke, projectRoot: root })
    try {
      install(true)
      const running = await agentInvocationsHandler(consoleEvent({
        context: { params: { agent: "support" } },
        body: ({ prompt: "Compile the digest." }),
        url: "http://localhost/_vitehub/api/agents/support/invocations",
      }))
      await vi.waitFor(async () => {
        expect(handlerStarted).toBe(true)
        await expect(definition.invocations?.get(running.id)).resolves.toMatchObject({ status: "running" })
      }, { timeout: 4_000 })
      await expect(getConsoleInvocationDetail(detailEvent(running.id))).resolves.toMatchObject({
        invocation: { actions: { cancel: { available: true } } },
      })

      install(false)
      const inspected = await getConsoleInvocationDetail(detailEvent(running.id))
      expect(inspected.invocation).not.toHaveProperty("actions")
      await expect(cancelConsoleInvocation(detailEvent(running.id, { action: "cancel" }))).rejects.toMatchObject({ statusCode: 403 })
      await expect(definition.invocations?.getSummary(running.id)).resolves.not.toHaveProperty("cancelRequestedAt")

      install(true)
      await expect(invocationHandler(detailEvent(running.id, { action: "delete" }))).rejects.toMatchObject({ statusCode: 409 })
      await expect(invocationHandler(detailEvent("missing", { action: "cancel" }))).rejects.toMatchObject({ statusCode: 404 })
      // A custom `run` Driver receives the abort signal, but the Console does not report the cancel as enforced.
      await expect(invocationHandler(detailEvent(running.id, { action: "cancel" }))).resolves.toEqual({
        delivery: "local",
        id: running.id,
        notEnforcedBy: "run",
        outcome: "requested",
        status: "running",
      })
      await expect(getConsoleInvocationDetail(detailEvent(running.id))).resolves.toMatchObject({
        invocation: { cancelNotEnforcedBy: "run", cancelRequestedAt: expect.any(String), status: "running" },
      })

      release("done")
      await vi.waitFor(async () => {
        await expect(definition.invocations?.get(running.id)).resolves.toMatchObject({ status: "completed" })
      }, { timeout: 4_000 })
      await expect(invocationHandler(detailEvent(running.id, { action: "cancel" }))).resolves.toMatchObject({ outcome: "terminal", status: "completed" })
      await expect(getConsoleInvocationDetail(detailEvent(running.id))).resolves.toMatchObject({
        invocation: { actions: { cancel: { available: true }, delete: { available: true }, rerun: { available: true, prompt: "Compile the digest." } } },
      })
      await expect(invocationHandler(detailEvent(running.id, { action: "delete" }))).resolves.toEqual({ id: running.id, outcome: "deleted" })
      await expect(definition.invocations?.getSummary(running.id)).resolves.toBeUndefined()
    }
    finally {
      release("done")
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each(["completed", "failed", "cancelled"] as const)("aborts a stale local custom execution with a %s journal through Console", async status => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-terminal-abort-"))
    const backing = createMemoryAgentInvocationStore()
    const invocations = defineAgentInvocations({ store: backing })
    let release: (value: string) => void = () => {}
    let signal: AbortSignal | undefined
    let ended = false
    const definition = defineAgent({ driver: { run: async ({ input }) => {
      signal = input.abortSignal
      const result = await new Promise<string>(resolve => { release = resolve })
      ended = true
      return result
    } }, invocations, name: "support" })
    const request = (id: string, body?: unknown): ConsoleRequestEvent => {
      const method = body === undefined ? "GET" : "POST"
      const url = `http://localhost/_vitehub/api/invocations/${id}`
      return consoleEvent({ body, method, remoteAddress: "127.0.0.1", url })
    }
    try {
      installConsoleAgentDefinitions([{ definition: { default: definition }, fallbackName: "help" }], { invoke: true, projectRoot: root })
      installConsoleInvocations(root, invocations)
      const { id } = await agentInvocationsHandler(consoleEvent({
        context: { params: { agent: "support" } },
        body: { prompt: "Work until released." },
        url: "http://localhost/_vitehub/api/agents/support/invocations",
      }))
      await vi.waitFor(() => expect(signal).toBeDefined())
      // A replacement owner writes a terminal state while the original handler still runs.
      await backing.update(id, { status, timestamp: new Date().toISOString() })
      const terminalRecord = await backing.get(id)
      installConsoleAgentDefinitions([{ definition: { default: definition }, fallbackName: "help" }], { invoke: false, projectRoot: root })
      expect((await getConsoleInvocationDetail(request(id))).invocation).not.toHaveProperty("actions")
      await expect(invocationHandler(request(id, { action: "cancel" }))).rejects.toMatchObject({ statusCode: 403 })
      expect(signal?.aborted).toBe(false)
      installConsoleAgentDefinitions([{ definition: { default: definition }, fallbackName: "help" }], { invoke: true, projectRoot: root })
      await expect(getConsoleInvocationDetail(request(id))).resolves.toMatchObject({
        invocation: { status, actions: { cancel: { available: true } } },
      })
      await expect(invocationHandler(request(id, { action: "cancel" }))).resolves.toEqual({ delivery: "local", id, notEnforcedBy: "run", outcome: "terminal", status })
      expect(signal?.aborted).toBe(true)
      expect(ended).toBe(false)
      expect(await backing.get(id)).toEqual(terminalRecord)
      release("done")
      await vi.waitFor(() => expect(ended).toBe(true))
    }
    finally { release("done"); await rm(root, { force: true, recursive: true }) }
  })

  it("rejects disabled Agents, unknown profiles, and unsupported fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-invoke-validation-"))
    const definition = defineAgent({
      driver: { run: () => "done" },
      invoker: { profiles: [{ id: "support", kind: "person" }] },
      name: "support",
    })
    const request = (body: unknown) => consoleEvent({
      context: { params: { agent: "support" } },
      body,
      url: "http://localhost/_vitehub/api/agents/support/invocations",
    })
    try {
      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { projectRoot: root })
      await expect(agentInvocationsHandler(request({ prompt: "hello" }))).rejects.toMatchObject({ statusCode: 404 })

      installConsoleAgentDefinitions([
        { definition: { default: definition }, fallbackName: "help" },
      ], { invoke: true, projectRoot: root })
      await expect(agentInvocationsHandler(request({ invokerProfileId: "unknown", prompt: "hello" })))
        .rejects.toMatchObject({ statusCode: 400, statusMessage: "Unknown Agent invocation profile." })
      await expect(agentInvocationsHandler(request({ extra: true, prompt: "hello" })))
        .rejects.toMatchObject({ statusCode: 400, statusMessage: "Unsupported Agent invocation field: extra." })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rebinds Console-owned direct Agent journals while preserving later user assignments", () => {
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const explicit = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = { ...defineAgent({ name: "support", driver: { run: () => "ok" } }) }
    const entries = [{ definition: { default: definition }, fallbackName: "help" }]

    installConsoleAgentDefinitions(entries, { invocations: first })
    expect(definition.invocations).toBe(first)

    installConsoleAgentDefinitions(entries, { invocations: second })
    expect(definition.invocations).toBe(second)

    definition.invocations = explicit
    installConsoleAgentDefinitions(entries, { invocations: first })
    expect(definition.invocations).toBe(explicit)
  })

  it("preserves an explicitly configured Agent invocation journal", () => {
    const explicitInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const consoleInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({
      driver: { run: () => "ok" },
      invocations: explicitInvocations,
      name: "support",
    })

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations: consoleInvocations })

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("installs a discovered Agent invocation journal as the Console journal", async () => {
    const projectRoot = "/configured-journal"
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({
      driver: { run: () => "ok" },
      invocations,
      name: "support",
    })

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { projectRoot })

    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: projectRoot })).toBe(invocations)
    await expect(listConsoleAgents()).resolves.toEqual({ agents: ["support"], invocationAgents: [] })
  })

  it("rejects multiple discovered Agent invocation journals", () => {
    const first = defineAgent({
      driver: { run: () => "ok" },
      invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
      name: "first",
    })
    const second = defineAgent({
      driver: { run: () => "ok" },
      invocations: defineAgentInvocations({ store: createMemoryAgentInvocationStore() }),
      name: "second",
    })

    expect(() => installConsoleAgentDefinitions([
      { definition: { default: first }, fallbackName: "first" },
      { definition: { default: second }, fallbackName: "second" },
    ], { projectRoot: "/multiple-journals" })).toThrow("Console cannot inspect multiple Agent invocation journals")
  })

  it("preserves an Agent invocation journal assigned after definition", () => {
    const explicitInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const consoleInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "support" })
    definition.invocations = explicitInvocations

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations: consoleInvocations })

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("uses the discovered name when an explicit Agent Definition name is blank", async () => {
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "   " })
    expect(definition.name).toBe("")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], { invocations })

    await expect(listConsoleAgents()).resolves.toEqual({ agents: ["help"], invocationAgents: [] })
  })

  it("rejects Agent names beyond the persisted identity limit", () => {
    expect(() => defineAgent({ driver: { run: () => "ok" }, name: "a".repeat(513) }))
      .toThrow("Agent names cannot exceed 512 characters")
  })

  it("rejects colliding discovered Agent names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-collision-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "review.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({
        console: productionConsole,
        sections: ["agents"],
      })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config = { root }
      await expect(
        Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }]),
      ).rejects.toThrow('Duplicate Agent name "review" discovered.')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("regenerates discovered Agents when definitions change in development", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-watch-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({ console: { auth: false }, sections: ["agents"] })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      await Reflect.apply(configHandler, {}, [{ root }, { command: "serve", mode: "development" }])

      const listeners = new Map<string, () => Promise<void>>()
      const configureServer = plugin.configureServer
      if (!configureServer) throw new TypeError("Expected a console development-server hook.")
      const configureServerHandler = "handler" in configureServer ? configureServer.handler : configureServer
      Reflect.apply(configureServerHandler, {}, [{ watcher: { on: (event: string, listener: () => Promise<void>) => listeners.set(event, listener) } }])

      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      await listeners.get("add")?.()
      await expect(readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8"))
        .resolves.toContain(`fallbackName: "support"`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("finds Agent names beyond the first persisted invocation page", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, agentName] of ["archived", ...Array.from({ length: 100 }, () => "current")].entries()) {
      store.create({
        agentName,
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `inv-${index}`,
        observations: [],
        status: "completed",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgents([], invocations)

    await expect(listConsoleAgents()).resolves.toEqual({
      agents: [],
      invocationAgents: ["archived", "current"],
    })
  })

  it("filters console sessions by exact Agent name", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const agentName of ["review", "review-assistant"]) {
      store.create({
        agentName,
        createdAt: "2026-08-23T12:00:00.000Z",
        id: agentName,
        observations: [],
        status: "completed",
        traceId: `trace-${agentName}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    await expect(listConsoleInvocations({ agent: "review" })).resolves.toMatchObject({
      invocations: [{ agentName: "review" }],
    })
  })

  it("filters console sessions by the exact capability that was used", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [id, capabilityId] of [["reported", "papercuts"], ["measured", "usage"]] as const) {
      store.create({
        agentName: "chat",
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [{
          attributes: { "capability.id": capabilityId },
          name: "agent.tool.finish",
          sequence: 1,
          timestamp: "2026-08-23T12:00:00.000Z",
          type: "run",
        }],
        status: "completed",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    await expect(listConsoleInvocations({ agent: "chat", capability: "papercuts" })).resolves.toMatchObject({
      invocations: [{ id: "reported" }],
    })
    await expect(listConsoleInvocationCapabilities({ agent: "chat" })).resolves.toEqual({
      capabilities: ["papercuts", "usage"],
      triggeredBy: [],
    })
  })

  it("filters Console sessions by the exact triggering person across pages and facets", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-08-23T12:00:00.000Z"
    for (let index = 0; index < 105; index++) {
      const triggeredBy = index === 0 || index === 104 ? "Ferdinand" : index === 1 ? "ferdinand" : index === 2 ? undefined : "Maxi"
      await store.create({
        agentName: index === 104 ? "chat" : "other",
        ...(triggeredBy ? { annotations: { triggeredBy } } : {}),
        capabilityIds: index === 104 ? ["papercuts"] : ["usage"],
        createdAt: timestamp,
        id: `person-${index}`,
        observations: [],
        status: "completed",
        traceId: `person-${index}-trace`,
        updatedAt: new Date(Date.parse(timestamp) + index).toISOString(),
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    await expect(listConsoleInvocations({ agent: "chat", capability: "papercuts", triggeredBy: "Ferdinand", limit: 1 })).resolves.toMatchObject({
      invocations: [{ id: "person-104" }],
    })

    await expect(listConsoleInvocations({ triggeredBy: "ferdinand" })).resolves.toMatchObject({
      invocations: [{ id: "person-1" }],
    })

    await expect(listConsoleInvocationCapabilities({ agent: "chat" })).resolves.toEqual({
      capabilities: ["papercuts"],
      triggeredBy: ["Ferdinand"],
    })
  })

  it("includes projected usage in Console session summaries", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "chat",
      annotations: { "agent.model.id": "claude-sonnet-4-5" },
      completedAt: "2026-08-23T12:01:00.000Z",
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "usage-summary",
      observations: [{
        attributes: {
          "usage.record": {
            cost: {
              display: "$0.03",
              estimated: false,
              source: "provider",
              usd: "0.03",
            },
            usage: { totalTokens: 42 },
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-23T12:01:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-usage-summary",
      updatedAt: "2026-08-23T12:01:00.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())

    await expect(listConsoleInvocations({})).resolves.toMatchObject({
      invocations: [{
        id: "usage-summary",
        usage: {
          cost: { display: "$0.03" },
          model: "claude-sonnet-4-5",
          totalTokens: 42,
        },
      }],
    })
  })

  it("returns only observations after a matching detail prefix", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "inv-delta",
      observations: [1, 2].map(sequence => ({
        name: "agent.invocation.running",
        sequence,
        timestamp: "2026-08-23T12:00:00.000Z",
        type: "lifecycle" as const,
      })),
      status: "running",
      traceId: "trace-delta",
      updatedAt: "2026-08-23T12:00:03.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const detailURL = "http://localhost/_vitehub/api/invocations/inv-delta"
    requestEvent.req!.url = detailURL
    const initial = await getConsoleInvocationDetail(requestEvent)
    await store.update("inv-delta", {
      observation: {
        name: "agent.invocation.running",
        sequence: 3,
        timestamp: "2026-08-23T12:00:03.000Z",
        type: "lifecycle",
      },
      timestamp: "2026-08-23T12:00:03.000Z",
    })
    const url = `${detailURL}?observationCount=2&observationCursor=${encodeURIComponent(initial.observationCursor)}`
    requestEvent.req!.url = url

    await expect(getConsoleInvocationDetail(requestEvent)).resolves.toMatchObject({
      appendObservations: true,
      invocation: { id: "inv-delta" },
      observations: [{ sequence: 3 }],
    })

    await store.update("inv-delta", {
      observation: {
        name: "agent.invocation.started",
        sequence: 0,
        timestamp: "2026-08-23T11:59:59.000Z",
        type: "lifecycle",
      },
      timestamp: "2026-08-23T12:00:04.000Z",
    })
    const replaced = await getConsoleInvocationDetail(requestEvent)
    expect(replaced.appendObservations).toBeUndefined()
    expect(replaced.observations.map(observation => observation.sequence)).toEqual([0, 1, 2, 3])

    await store.update("inv-delta", {
      observationsTruncated: true,
      timestamp: "2026-08-23T12:00:05.000Z",
    })
    const truncatedURL = `${detailURL}?observationCount=4&observationCursor=${encodeURIComponent(replaced.observationCursor)}`
    requestEvent.req!.url = truncatedURL
    await expect(getConsoleInvocationDetail(requestEvent)).resolves.not.toHaveProperty("appendObservations")
  })

  it("rejects malformed invocation URL ids with a client error", async () => {
    installConsoleInvocationFallback(defineAgentInvocations({ store: createMemoryAgentInvocationStore() }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const malformedURL = "http://localhost/_vitehub/api/invocations/%E0%A4%A"
    requestEvent.req!.url = malformedURL

    await expect(invocationHandler(requestEvent)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "Malformed invocation id.",
    })
  })

  it.each([false, true])("rejects malformed invocation URL ids with route params: %s", async (withParams) => {
    installConsoleInvocationFallback(defineAgentInvocations({ store: createMemoryAgentInvocationStore() }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const malformedURL = "http://localhost/_vitehub/api/invocations/%E0%A4%A"
    requestEvent.req!.url = malformedURL
    if (withParams) requestEvent.context = { params: { id: "%E0%A4%A" } }

    await expect(invocationHandler(requestEvent)).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: "Malformed invocation id.",
    })
  })

  it.each(["team/run", "team%2Frun", "%E0%A4%A"])("decodes invocation URL ids once: %s", async (id) => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-08-23T12:00:00.000Z"
    await store.create({ id, createdAt: timestamp, updatedAt: timestamp, status: "completed", observations: [], traceId: "trace-encoded" })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    for (const paramId of [encodeURIComponent(id), id]) {
      const requestEvent = event("127.0.0.1")
      const url = `http://localhost/_vitehub/api/invocations/${encodeURIComponent(id)}`
      requestEvent.req!.url = url
      requestEvent.context = { params: { id: paramId } }
      await expect(invocationHandler(requestEvent)).resolves.toMatchObject({ invocation: { id } })
    }
  })

  it("bounds each console response to the requested page size", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["pending", "pending", "pending", "completed", "completed", "completed"] as const).entries()) {
      store.create({
        createdAt: `2026-08-23T12:00:00.000Z`,
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const query = { limit: 2 }

    const result = await listConsoleInvocations(query)

    expect(result.invocations.map(invocation => invocation.id)).toEqual(["pending-2", "completed-5"])
    expect(result.cursor).toBeDefined()

    const next = await listConsoleInvocations({ ...query, cursor: result.cursor! })

    expect(next.invocations.map(invocation => invocation.id)).toEqual(["pending-1", "completed-4"])
    expect(next.cursor).toBeDefined()

    const last = await listConsoleInvocations({ ...query, cursor: next.cursor! })

    expect(last.invocations.map(invocation => invocation.id)).toEqual(["pending-0", "completed-3"])
    expect(last.cursor).toBeDefined()
  })

  it("caps composite console pages at the invocation list maximum", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 240; index++) {
      const status = index % 2 === 0 ? "pending" : "completed"
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 1000 })

    expect(result.invocations).toHaveLength(100)
    expect(result.cursor).toBeDefined()
  })

  it("backfills page capacity from a populated lifecycle", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 60; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 50 })

    expect(result.invocations).toHaveLength(50)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(50)
    expect(result.invocations.every(invocation => invocation.status === "pending")).toBe(true)
    expect(result.cursor).toBeDefined()
  })

  it("rechecks later lifecycles after backfilling an earlier group", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 6; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && ++pendingReads === 2) {
        await store.update("pending-4", {
          status: "running",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 3 })

    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-4",
      status: "running",
    }))
    expect(result.invocations).toHaveLength(3)
    expect(result.cursor).toBeDefined()
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: "4" })
  })

  it("shares the backfill budget across lifecycle rechecks", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && ++pendingReads === 2) {
        for (const index of [6, 7, 8, 9]) {
          await store.update(`pending-${index}`, {
            status: index < 8 ? "running" : "completed",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 6 })

    expect(result.invocations).toHaveLength(6)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(6)
    expect(result.invocations.some(invocation => invocation.status === "running")).toBe(true)
    expect(result.invocations.some(invocation => invocation.status === "completed")).toBe(true)
  })

  it("caps replacement lifecycle rechecks to the remaining response budget", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 3; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let queuedRead = false
    let workingRead = false
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending") && !queuedRead) {
        queuedRead = true
        for (let index = 0; index < 3; index++) {
          await store.update(`pending-${index}`, {
            status: "running",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      else if (Array.isArray(options?.status) && options.status.includes("running") && !workingRead) {
        workingRead = true
        await store.update("pending-2", {
          status: "completed",
          timestamp: "2026-08-23T12:02:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 2 })

    expect(result.invocations).toHaveLength(2)
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(2)
    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-2",
      status: "completed",
    }))
  })

  it("rechecks later lifecycles after refilling a rolled-back backfill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        pendingReads++
        if (pendingReads === 2) {
          for (const index of [6, 7, 8, 9]) {
            await store.update(`pending-${index}`, {
              status: index < 8 ? "running" : "completed",
              timestamp: "2026-08-23T12:01:00.000Z",
            })
          }
        }
        if (pendingReads === 3) {
          await store.update("pending-5", {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
      }
      return list(options)
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 6 })

    expect(result.invocations).toContainEqual(expect.objectContaining({
      id: "pending-5",
      status: "running",
    }))
    expect(result.invocations).toHaveLength(6)
  })

  it("keeps the cursor produced by the final refill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    const queuedCursors: (string | undefined)[] = []
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        pendingReads++
        if (pendingReads === 2) {
          for (const index of [6, 7, 8, 9]) {
            await store.update(`pending-${index}`, {
              status: index < 8 ? "running" : "completed",
              timestamp: "2026-08-23T12:01:00.000Z",
            })
          }
        }
        if (pendingReads === 3) {
          await store.update("pending-5", {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
        if (pendingReads === 4) {
          await store.update("pending-4", {
            status: "running",
            timestamp: "2026-08-23T12:03:00.000Z",
          })
        }
      }
      const result = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        queuedCursors.push(result.cursor)
      }
      return result
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const query = { limit: 6 }

    const result = await listConsoleInvocations(query)

    expect(result.invocations).toHaveLength(6)
    expect(queuedCursors).toHaveLength(4)
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: queuedCursors.at(-1) })
    expect(result.remainingStatuses).toContain("pending")

    const visited = new Set<string>()
    let cursor = result.cursor
    let transitioned
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const next = await listConsoleInvocations({ ...query, cursor })
      transitioned = next.invocations.find(invocation => invocation.id === "pending-4")
      if (transitioned) break
      cursor = next.cursor
    }

    expect(transitioned).toMatchObject({ id: "pending-4", status: "running" })
  })

  it("preserves an earlier lifecycle cursor when transitions consume its refill", async () => {
    const store = createMemoryAgentInvocationStore()
    for (let index = 0; index < 10; index++) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `pending-${index}`,
        observations: [],
        status: "pending",
        traceId: `trace-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    let pendingReads = 0
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (!Array.isArray(options?.status) || !options.status.includes("pending")) return list(options)
      pendingReads++
      if (pendingReads === 2) {
        for (const index of [6, 7, 8, 9]) {
          await store.update(`pending-${index}`, {
            status: index < 8 ? "running" : "completed",
            timestamp: "2026-08-23T12:01:00.000Z",
          })
        }
      }
      const page = await list(options)
      if (pendingReads === 3) {
        for (const index of [4, 5]) {
          await store.update(`pending-${index}`, {
            status: "running",
            timestamp: "2026-08-23T12:02:00.000Z",
          })
        }
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 6 })

    expect(result.invocations).toHaveLength(6)
    expect(JSON.parse(result.cursor!)).toMatchObject({ queued: "5" })
    expect(result.remainingStatuses).toContain("pending")
  })

  it("preserves empty opaque cursors across lifecycle pages", async () => {
    const store = createMemoryAgentInvocationStore()
    const pending = (id: string) => ({
      agentName: undefined,
      createdAt: "2026-08-23T12:00:00.000Z",
      cursor: id,
      id,
      status: "pending" as const,
      traceId: `trace-${id}`,
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const listSpy = vi.spyOn(store, "list").mockImplementation(async (options) => {
      if (Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === "") {
        return { invocations: [pending("pending-older")] }
      }
      return Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === undefined
        ? { cursor: "", invocations: [pending("pending-newer")] }
        : { invocations: [] }
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const first = await listConsoleInvocations({ limit: 3 })
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["pending-newer", "pending-older"])
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ cursor: "", status: ["pending"] }))
  })

  it("deduplicates an invocation that becomes terminal between lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "transitioning",
      observations: [],
      status: "pending",
      traceId: "trace-transitioning",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        await store.update("transitioning", {
          status: "completed",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 2 })

    expect(result.invocations).toMatchObject([{
      id: "transitioning",
      status: "completed",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }])
  })

  it("reclaims page capacity after deduplicating lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["older", "transitioning"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [],
        status: "pending",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending") && options.cursor === undefined) {
        await store.update("transitioning", {
          status: "completed",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 2 })

    expect(result.invocations.map(invocation => invocation.id)).toEqual(["older", "transitioning"])
    expect(new Set(result.invocations.map(invocation => invocation.id)).size).toBe(2)
  })

  it("preserves an invocation that becomes terminal between pages", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["transitioning", "newer", "newest"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [],
        status: "running",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const query = { limit: 2 }

    const first = await listConsoleInvocations(query)
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["newest", "newer"])
    await store.update("transitioning", {
      status: "completed",
      timestamp: "2026-08-23T12:01:00.000Z",
    })

    let page = await listConsoleInvocations({ ...query, cursor: first.cursor! })
    while (!page.invocations.some(invocation => invocation.id === "transitioning") && page.cursor) {
      page = await listConsoleInvocations({ ...query, cursor: page.cursor })
    }

    expect(page.invocations).toContainEqual(expect.objectContaining({
      id: "transitioning",
      status: "completed",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }))
  })

  it("reports only terminal lifecycles while the unfiltered history cursor remains", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["running", "pending", "completed"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ cursor: JSON.stringify({ history: null }), limit: 1 })

    expect(result.cursor).toBeDefined()
    expect(result.remainingStatuses).toEqual([
      "cancelled",
      "completed",
      "failed",
    ])
  })

  it("keeps an invocation that starts running between lifecycle reads", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "starting",
      observations: [],
      status: "pending",
      traceId: "trace-starting",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    const list = store.list.bind(store)
    vi.spyOn(store, "list").mockImplementation(async (options) => {
      const page = await list(options)
      if (Array.isArray(options?.status) && options.status.includes("pending")) {
        await store.update("starting", {
          status: "running",
          timestamp: "2026-08-23T12:01:00.000Z",
        })
      }
      return page
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ limit: 2 })

    expect(result.invocations).toMatchObject([{
      id: "starting",
      status: "running",
      updatedAt: "2026-08-23T12:01:00.000Z",
    }])
  })

  it("continues active pagination after terminal sessions are exhausted", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["completed", "pending", "pending", "pending"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const query = { limit: 2 }

    const first = await listConsoleInvocations(query)
    expect(first.invocations.map(invocation => invocation.id)).toEqual(["pending-3", "completed-0"])
    expect(first.cursor).toBeDefined()

    const second = await listConsoleInvocations({ ...query, cursor: first.cursor! })
    expect(second.invocations.map(invocation => invocation.id)).toEqual(["pending-2", "pending-1"])
    expect(second.cursor).toBeDefined()
  })

  it("preserves deferred active pagination while serving terminal sessions", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [index, status] of (["completed", "completed", "pending", "pending"] as const).entries()) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id: `${status}-${index}`,
        observations: [],
        status,
        traceId: `trace-${status}-${index}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const query = { limit: 1 }

    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await listConsoleInvocations({ ...query, cursor })
      ids.push(...page.invocations.map(invocation => invocation.id))
      cursor = page.cursor
    } while (cursor)

    expect([...new Set(ids)]).toEqual(["pending-3", "completed-1", "pending-2", "completed-0"])
  })

  it("summarizes recorded usage and marks missing completion evidence unavailable", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "review",
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "usage-invocation",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                model: "model-a",
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              },
              {
                cost: { display: "$0.02", estimated: true, source: "estimated", usd: "0.02" },
                model: "model-b",
                usage: { inputTokens: 8, outputTokens: 7, totalTokens: 15 },
              },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    store.create({
      completedAt: "2026-08-27T10:30:00.000Z",
      createdAt: "2026-08-27T10:29:00.000Z",
      id: "missing-usage",
      observations: [],
      status: "completed",
      traceId: "trace-missing-usage",
      updatedAt: "2026-08-27T10:30:00.000Z",
    })
    store.create({
      completedAt: "2026-08-28T10:00:00.000Z",
      createdAt: "2026-08-28T10:00:00.000Z",
      id: "future-usage",
      observations: [{
        attributes: { "usage.record": { usage: { totalTokens: 999 } } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-28T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-future-usage",
      updatedAt: "2026-08-28T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })

    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      buckets: expect.arrayContaining([
        expect.objectContaining({
          costAvailable: false,
          costEstimated: true,
          costUsd: "0.03",
          invocations: 2,
          start: "2026-08-27T10:00:00.000Z",
          totalTokens: 30,
          totalTokensAvailable: false,
        }),
      ]),
      costAvailable: false,
      models: [
        { costEstimated: false, costUsd: "0.01", invocations: 1, model: "model-a", totalTokens: 15 },
        { costEstimated: true, costUsd: "0.02", invocations: 1, model: "model-b", totalTokens: 15 },
      ],
      partial: true,
      resolution: "hour",
      totals: {
        costAvailable: false,
        costEstimated: true,
        costUsd: "0.03",
        inputTokens: 18,
        inputTokensAvailable: false,
        invocations: 2,
        outputTokens: 12,
        outputTokensAvailable: false,
        totalTokens: 30,
        totalTokensAvailable: false,
      },
    })
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      buckets: expect.arrayContaining([
        expect.objectContaining({
          costAvailable: true,
          costEstimated: false,
          costUsd: "0",
          invocations: 0,
          start: "2026-08-27T11:00:00.000Z",
          totalTokensAvailable: true,
        }),
      ]),
    })
    expect(invocationUsage((await invocations.get("usage-invocation"))!)).toMatchObject({
      cost: { estimated: true, source: "mixed", usd: "0.03" },
      inputTokens: 18,
      outputTokens: 12,
      totalTokens: 30,
    })
  })

  it("projects cached input tokens from supported usage records", () => {
    const invocation = (usage: Record<string, unknown>) => ({
      createdAt: "2026-08-27T09:59:00.000Z",
      cursor: "cached-usage",
      id: "cached-usage",
      observations: [{
        attributes: { "usage.record": { usage } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace-cached-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })

    expect(invocationUsage(invocation({ inputTokenDetails: { cachedTokens: 4 } })))
      .toMatchObject({ cachedInputTokens: 4 })
    expect(invocationUsage(invocation({ details: { cachedInputTokens: 6 } })))
      .toMatchObject({ cachedInputTokens: 6 })
  })

  it("keeps incomplete nested usage dimensions unavailable", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "partial-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                model: "priced-input",
                usage: { inputTokens: 10, totalTokens: 10 },
              },
              {
                model: "unpriced-output",
                usage: { outputTokens: 5, totalTokens: 5 },
              },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-partial-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    const record = (await invocations.get("partial-usage"))!
    const projected = invocationUsage(record)

    expect(projected).toMatchObject({ totalTokens: 15 })
    expect(projected).not.toHaveProperty("cost")
    expect(projected).not.toHaveProperty("inputTokens")
    expect(projected).not.toHaveProperty("outputTokens")
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      costAvailable: false,
      models: [
        expect.objectContaining({ costAvailable: true, model: "priced-input", outputTokensAvailable: false }),
        expect.objectContaining({ costAvailable: false, inputTokensAvailable: false, model: "unpriced-output" }),
      ],
      totals: {
        costAvailable: false,
        inputTokensAvailable: false,
        outputTokensAvailable: false,
        totalTokens: 15,
        totalTokensAvailable: true,
      },
    })
  })

  it("preserves recursive usage evidence and arbitrary decimal scale", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "recursive-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [{
              calls: [
                {
                  cost: { display: "$0.000000000000000000005", estimated: false, source: "provider", usd: "0.000000000000000000005" },
                  model: "leaf-a",
                  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
                },
                {
                  cost: { display: "$0.000000000000000000005", estimated: false, source: "provider", usd: "0.000000000000000000005" },
                  model: "leaf-b",
                  usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
                },
              ],
            }],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-recursive-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    const invocations = defineAgentInvocations({ store })
    const projected = invocationUsage((await invocations.get("recursive-usage"))!)

    expect(projected).toMatchObject({
      calls: [{ model: "leaf-a" }, { model: "leaf-b" }],
      cost: { usd: "0.00000000000000000001" },
      totalTokens: 15,
    })
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      models: [{ model: "leaf-b" }, { model: "leaf-a" }],
      totals: { costUsd: "0.00000000000000000001", totalTokens: 15 },
    })
  })

  it("does not synthesize complete parent evidence across raw-only calls", async () => {
    const record = {
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T10:00:00.000Z",
      cursor: "raw-only-usage",
      id: "raw-only-usage",
      observations: [{
        attributes: {
          "usage.record": {
            calls: [
              {
                cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              },
              { raw: { requestId: "raw-only" } },
            ],
          },
        },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle" as const,
      }],
      status: "completed" as const,
      traceId: "trace-raw-only-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    } satisfies Parameters<typeof invocationUsage>[0]

    const projected = invocationUsage(record)
    expect(projected).not.toHaveProperty("cost")
    expect(projected).not.toHaveProperty("inputTokens")
    expect(projected).not.toHaveProperty("outputTokens")
    expect(projected).not.toHaveProperty("totalTokens")
  })

  it("includes completed sessions while keeping missing usage unavailable", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-08-27T09:59:00.000Z",
      id: "missing-only",
      observations: [],
      status: "completed",
      traceId: "trace-missing-only",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })

    await expect(createUsageSummary(defineAgentInvocations({ store }), {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      models: [],
      totals: { costAvailable: false, invocations: 1, totalTokensAvailable: false },
    })
  })

  it("keeps scalar totals of truncated finish usage and marks the summary partial", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [id, truncated] of [["complete", false], ["truncated", true]] as const) {
      const attributes: Record<string, unknown> = {
        "usage.record": {
          model: id,
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
        },
      }
      if (truncated) {
        attributes["vitehub.observation.truncated"] = true
      }
      store.create({
        completedAt: "2026-08-27T10:00:00.000Z",
        createdAt: "2026-08-27T09:59:00.000Z",
        id,
        observations: [{
          attributes,
          name: "agent.invocation.finish",
          sequence: 1,
          timestamp: "2026-08-27T10:00:00.000Z",
          type: "lifecycle",
        }],
        status: "completed",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })

    // A long result text truncates the observation, but the Agent keeps the scalar usage totals.
    expect(invocationUsage((await invocations.get("truncated"))!)).toEqual({
      inputTokens: 4,
      model: "truncated",
      outputTokens: 6,
      totalTokens: 10,
    })
    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      sessions: expect.arrayContaining([
        expect.objectContaining({ id: "complete", partial: false }),
        expect.objectContaining({ id: "truncated", partial: true }),
      ]),
      models: [
        expect.objectContaining({ model: "complete", totalTokens: 10 }),
        expect.objectContaining({ model: "truncated", totalTokens: 10 }),
      ],
      partial: true,
      totals: {
        inputTokens: 8,
        inputTokensAvailable: true,
        invocations: 2,
        outputTokens: 12,
        outputTokensAvailable: true,
        totalTokens: 20,
        totalTokensAvailable: true,
      },
    })
  })

  it("scans creation-ordered pages for recent completions", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      completedAt: "2026-08-27T10:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "long-running-usage",
      observations: [{
        attributes: { "usage.record": { usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 } } },
        name: "agent.invocation.finish",
        sequence: 1,
        timestamp: "2026-08-27T10:00:00.000Z",
        type: "lifecycle",
      }],
      status: "completed",
      traceId: "trace-long-running-usage",
      updatedAt: "2026-08-27T10:00:00.000Z",
    })
    for (let index = 0; index < 100; index++) {
      store.create({
        completedAt: "2026-01-02T00:00:00.000Z",
        createdAt: "2026-01-02T00:00:00.000Z",
        id: `old-usage-${index}`,
        observations: [],
        status: "completed",
        traceId: `trace-old-usage-${index}`,
        updatedAt: "2026-01-02T00:00:00.000Z",
      })
    }
    const invocations = defineAgentInvocations({ store })

    await expect(createUsageSummary(invocations, {
      now: "2026-08-27T12:00:00.000Z",
      window: "24h",
    })).resolves.toMatchObject({
      available: true,
      partial: false,
      totals: { invocations: 1, totalTokens: 10 },
    })
  })

  it("rejects overlong Agent filters at the usage endpoint", async () => {
    const requestEvent = event("127.0.0.1")
    const url = `http://localhost/_vitehub/api/usage?agent=${"a".repeat(513)}`
    if (!requestEvent.req) throw new TypeError("Expected a request event.")
    requestEvent.req.url = url

    await expect(usageHandler(requestEvent)).rejects.toMatchObject({ statusCode: 400 })
  })

  it("reports the diagnostic code for an invalid usage cursor", async () => {
    installConsoleInvocationFallback(defineAgentInvocations({ store: createMemoryAgentInvocationStore() }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/_vitehub/api/usage?cursor=invalid"
    if (!requestEvent.req) throw new TypeError("Expected a request event.")
    requestEvent.req.url = url

    await expect(usageHandler(requestEvent)).rejects.toMatchObject({
      code: "VITE_HUB_R0115",
      statusCode: 400,
    })
  })

  it("keeps the all-Agent usage cache separate from an Agent named star", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = new Date(Date.now() - 1_000).toISOString()
    for (const [agentName, totalTokens] of [["*", 1], ["review", 2]] as const) {
      store.create({
        agentName,
        completedAt: timestamp,
        createdAt: timestamp,
        id: `cache-${agentName}`,
        observations: [{
          attributes: { "usage.record": { usage: { totalTokens } } },
          name: "agent.invocation.finish",
          sequence: 1,
          timestamp,
          type: "lifecycle",
        }],
        status: "completed",
        traceId: `trace-cache-${agentName}`,
        updatedAt: timestamp,
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const allEvent = event("127.0.0.1")
    const starEvent = event("127.0.0.1")
    const allUrl = "http://localhost/_vitehub/api/usage"
    const starUrl = "http://localhost/_vitehub/api/usage?agent=*"
    allEvent.req!.url = allUrl
    starEvent.req!.url = starUrl

    await expect(usageHandler(allEvent)).resolves.toMatchObject({ totals: { totalTokens: 3 } })
    await expect(usageHandler(starEvent)).resolves.toMatchObject({ totals: { totalTokens: 1 } })
  })

  it("searches session text through the console Collection", async () => {
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName: "babysitter",
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "matching-invocation",
      observations: [{
        attributes: { "message.content": "The pull request was merged via the queue." },
        name: "agent.message",
        sequence: 1,
        timestamp: "2026-08-23T12:00:00.000Z",
        type: "run",
      }],
      status: "completed",
      traceId: "matching-trace",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    store.create({
      agentName: "review",
      createdAt: "2026-08-23T11:00:00.000Z",
      id: "other-invocation",
      observations: [],
      status: "completed",
      traceId: "other-trace",
      updatedAt: "2026-08-23T11:00:00.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())

    const query = await consoleSearch.parseQuery({ search: "merged via" })
    await expect(consoleSearch.page({ query })).resolves.toEqual({
      items: [{
        agentName: "babysitter",
        context: "matching-invocation",
        excerpt: "The pull request was merged via the queue.",
        id: "matching-invocation",
        status: "completed",
        updatedAt: "2026-08-23T12:00:00.000Z",
      }],
      nextCursor: null,
    })

    const response = await consoleSearchCollectionHandler.fetch(new Request("http://localhost/search?limit=12&search=merged%20via"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "matching-invocation" })],
      nextCursor: null,
    })

    const invalidResponse = await consoleSearchCollectionHandler.fetch(new Request("http://localhost/search?search=one&search=two"))
    expect(invalidResponse.status).toBe(400)
  })

  it("accepts persisted Agent names up to the metadata limit", async () => {
    const agentName = "a".repeat(512)
    const store = createMemoryAgentInvocationStore()
    store.create({
      agentName,
      createdAt: "2026-08-23T12:00:00.000Z",
      id: "long-name",
      observations: [],
      status: "completed",
      traceId: "trace-long-name",
      updatedAt: "2026-08-23T12:00:00.000Z",
    })
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    await expect(listConsoleInvocations({ agent: agentName })).resolves.toMatchObject({
      invocations: [{ agentName }],
    })
  })

  it("refreshes invocation summaries with usage in one request without observations", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["inv-1", "inv-2"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [{
          attributes: id === "inv-1"
            ? { "usage.record": { usage: { totalTokens: 42 } } }
            : undefined,
          name: "agent.invocation.finish",
          sequence: 1,
          timestamp: "2026-08-23T12:00:00.000Z",
          type: "run",
        }],
        status: "running",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    const get = vi.spyOn(store, "get")
    const getSummary = vi.spyOn(store, "getSummary")
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const result = await listConsoleInvocations({ id: ["inv-1", "inv-2"] })
    expect(result).toMatchObject({
      invocations: [{ id: "inv-1", usage: { totalTokens: 42 } }, { id: "inv-2" }],
    })
    expect(result).toEqual({
      invocations: [
        expect.not.objectContaining({ observations: expect.anything() }),
        expect.not.objectContaining({ observations: expect.anything() }),
      ],
    })
    expect(getSummary).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(1, "inv-1", { observationNames: ["agent.invocation.finish"] })
    expect(get).toHaveBeenNthCalledWith(2, "inv-2", { observationNames: ["agent.invocation.finish"] })
  })

  it("gives framework Agent Definitions without a store the app-wide journal, never a Console journal", () => {
    scope[consoleInvocationsKey] = fakeInvocations("console")

    const agent = defineAgent({ driver: { run: () => "ok" } })

    expect(agent.invocations).toBeUndefined()
    installAgentInvocations({ default: "memory" })
    expect(agent.invocations).toBeDefined()
    expect(agent.invocations).not.toBe(scope[consoleInvocationsKey])
  })

  it("preserves an explicitly configured invocation journal", () => {
    const explicit = fakeInvocations("explicit")
    scope[consoleInvocationsKey] = fakeInvocations("console")

    const agent = defineAgent({ driver: { run: () => "ok" }, invocations: explicit })

    expect(agent.invocations).toBe(explicit)
  })

  it("lets a later invocation journal assignment replace the console fallback", () => {
    scope[consoleInvocationsKey] = fakeInvocations("console")
    const agent = defineAgent({ driver: { run: () => "ok" } })
    const assigned = fakeInvocations("assigned")

    agent.invocations = assigned
    scope[consoleInvocationsKey] = fakeInvocations("replacement")

    expect(agent.invocations).toBe(assigned)
  })

  it("shares the installed journal through the process across module realms", () => {
    const fallback = fakeInvocations("console")
    Reflect.set(process, consoleInvocationsKey, fallback)

    expect(resolveConsoleInvocations({ process })).toBe(fallback)
  })

  it("reads a journal registry created in another module realm", () => {
    const fallback = fakeInvocations("console")
    const foreignRegistry = runInNewContext("new Map()")
    foreignRegistry.set("/project", fallback)
    Reflect.set(process, consoleInvocationsRegistryKey, foreignRegistry)

    expect(
      resolveConsoleInvocations({
        process,
        [consoleProjectRootKey]: "/project",
      }),
    ).toBe(fallback)
  })

  it("resolves the current journal identity from a project-root-only Agent realm", () => {
    const fixture = fakeInvocations("fixture")
    installConsoleInvocationFallback(fixture, "/project", { process }, "runtime:/project")

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).get("/project")).toBe("runtime:/project")
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(fixture)
  })

  it("keeps each same-root runtime bound to its installed journal identity", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process }
    const secondScope = { process }

    installConsoleInvocationFallback(first, "/project", firstScope, "runtime:/project:first")
    installConsoleInvocationFallback(second, "/project", secondScope, "runtime:/project:second")

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(second)
  })

  it("keeps process-shared journals scoped to their project root", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process, [consoleProjectRootKey]: "/first" }
    const secondScope = { process, [consoleProjectRootKey]: "/second" }

    installConsoleInvocationFallback(first, "/first", firstScope)
    installConsoleInvocationFallback(second, "/second", secondScope)

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
  })

  it("binds isolated Vite SSR Agent realms to their own project journal", async () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    installConsoleInvocationFallback(first, "/first", { process })
    installConsoleInvocationFallback(second, "/second", { process })
    const firstAgentRealm = { process }
    const secondAgentRealm = { process }
    const unboundAgentRealm = { process }

    const bind = async (projectRoot: string, realm: object, identity?: string) => {
      const plugin = consoleInvocationRootPlugin(projectRoot, identity)
      // SAFETY: The console plugin declares this environment predicate on its Vite Plugin contract.
      const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with a focused fake context.
      const buildStart = plugin.buildStart as unknown as (this: typeof context) => Promise<void>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with focused arguments.
      const transform = plugin.transform as unknown as (
        code: string,
        id: string,
      ) => string | undefined | Promise<string | undefined>
      const resolvedAgentEntry = "/app/node_modules/vite-hub/dist/agent.js"
      const context = {
        error(message: string): never {
          throw new TypeError(message)
        },
        resolve: vi.fn(async () => ({ external: true, id: resolvedAgentEntry })),
      }
      // SAFETY: The focused test inputs provide the only environment field read by the predicate.
      expect(await applyToEnvironment({ config: { consumer: "server" } } as never)).toBe(true)
      // SAFETY: The focused test inputs provide the only environment field read by the predicate.
      expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
      await Reflect.apply(buildStart, context, [])
      const resolved = await callPluginHook(plugin.resolveId, context, ["vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false }])
      const code = await transform("globalThis.agentModuleEvaluated = true", resolvedAgentEntry)
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", undefined, { skipSelf: true })
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false, skipSelf: true })
      expect(resolved).toEqual({ external: false, id: resolvedAgentEntry })
      // SAFETY: The evaluated fixture explicitly returns its VM global object.
      return runInNewContext(`${code}\nglobalThis`, realm) as object
    }

    expect(Reflect.has(firstAgentRealm, consoleProjectRootKey)).toBe(false)
    expect(Reflect.has(secondAgentRealm, consoleProjectRootKey)).toBe(false)
    expect(resolveConsoleInvocations(unboundAgentRealm)).toBeUndefined()

    const boundFirstAgentRealm = await bind("/first", firstAgentRealm)
    const boundSecondAgentRealm = await bind("/second", secondAgentRealm)

    expect(resolveConsoleInvocations(boundFirstAgentRealm)).toBe(first)
    expect(resolveConsoleInvocations(boundSecondAgentRealm)).toBe(second)
  })

  it("binds same-root isolated Agent realms to their owning runtime journal", async () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const projectRoot = "/project"
    const firstIdentity = "runtime:/project:first"
    const secondIdentity = "runtime:/project:second"
    installConsoleInvocationFallback(first, projectRoot, { process }, firstIdentity)
    installConsoleInvocationFallback(second, projectRoot, { process }, secondIdentity)

    const transform = async (identity: string) => {
      const plugin = consoleInvocationRootPlugin(projectRoot, identity)
      const resolvedAgentEntry = "/app/node_modules/vite-hub/dist/agent.js"
      const context = {
        error(message: string): never { throw new TypeError(message) },
        resolve: vi.fn(async () => ({ external: true, id: resolvedAgentEntry })),
      }
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
      const buildStart = plugin.buildStart as unknown as (this: typeof context) => Promise<void>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
      const transformHook = plugin.transform as unknown as (code: string, id: string) => string
      await Reflect.apply(buildStart, context, [])
      return transformHook("", resolvedAgentEntry)
    }

    // SAFETY: Each generated script returns the isolated realm's global object.
    const firstRealm = runInNewContext(`${await transform(firstIdentity)}\nglobalThis`, { process }) as object
    // SAFETY: Each generated script returns the isolated realm's global object.
    const secondRealm = runInNewContext(`${await transform(secondIdentity)}\nglobalThis`, { process }) as object

    expect(resolveConsoleInvocations(firstRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)
  })

  it("keeps the project-root binding out of client environments", async () => {
    const plugin = consoleInvocationRootPlugin("/private/project")
    // SAFETY: The console plugin declares this environment predicate on its Vite Plugin contract.
    const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with focused arguments.
    const configEnvironment = plugin.configEnvironment as unknown as (
      name: string,
      config: { consumer: "client" | "server" },
    ) => unknown

    // SAFETY: The focused test input provides the only environment field read by the predicate.
    expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({ resolve: { noExternal: ["vite-hub"] } })
  })

  it("binds the project root when a real Vite development server loads an Agent realm", async () => {
    const root = await mkdtemp(join(import.meta.dirname, ".console-vite-"))
    const projectRoot = join(root, "project")
    const frameworkAgentEntry = createRequire(import.meta.url).resolve("vite-hub/agent")
    await writeFile(
      join(root, "agent-root.ts"),
      [`import ${JSON.stringify(frameworkAgentEntry)}`, 'export const projectRoot = globalThis[Symbol.for("vitehub.console.invocations.root")]', ""].join("\n"),
    )
    let server: Awaited<ReturnType<typeof createServer>> | undefined

    try {
      server = await createServer({
        configFile: false,
        plugins: [consoleInvocationRootPlugin(projectRoot)],
        root,
        server: { middlewareMode: true },
      })
      // SAFETY: The fixture module exports only the projectRoot value asserted below.
      const loaded = await server.ssrLoadModule(join(root, "agent-root.ts")) as { projectRoot?: string }
      expect(loaded.projectRoot).toBe(projectRoot)
    }
    finally {
      await server?.close()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("persists the configured default journal across instances and isolates another URL", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-configured-"))
    const databaseUrl = pathToFileURL(join(projectRoot, "persistent", "history.sqlite")).href
    const otherUrl = pathToFileURL(join(projectRoot, "persistent", "other.sqlite")).href
    try {
      const writer = installDefaultJournal(projectRoot, { databaseUrl })
      expect(installDefaultJournal(projectRoot, { databaseUrl })).toBe(writer)
      const agent = defineAgent({ driver: { run: () => "stored at configured path" }, runtime: false })
      await runAgentWithContext(agent, runtime("configured-console-storage"), {})
      const readers = [createDefaultAgentInvocations({ databaseUrl, projectRoot }), createDefaultAgentInvocations({ databaseUrl, projectRoot })]
      for (const reader of readers) {
        await expect(reader.getByRunId("configured-console-storage")).resolves.toMatchObject({ status: "completed" })
      }
      const other = installDefaultJournal(projectRoot, { databaseUrl: otherUrl })
      expect(other).not.toBe(writer)
      await expect(other.getByRunId("configured-console-storage")).resolves.toBeUndefined()
      expect(existsSync(join(projectRoot, "persistent", "history.sqlite"))).toBe(true)
      expect(existsSync(join(projectRoot, ".vitehub", "data", "agent-invocations.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("allows a runtime URL to override the configured journal URL", async () => {
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "libsql://runtime.example.com")
    await expect(resolveDefaultAgentInvocationsLocation({ databaseUrl: "libsql://configured.example.com", projectRoot: process.cwd() })).resolves.toEqual({ url: "libsql://runtime.example.com" })
  })

  it("anchors the durable journal to the project root and shares it between runtime instances", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-cwd-"))
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      const writer = installDefaultJournal(projectRoot)
      const agent = defineAgent({ driver: { run: () => "persisted" }, runtime: false, version: "1.0.0" })
      await runAgentWithContext(agent, runtime("console-cross-realm"), {})

      const reader = createDefaultAgentInvocations({ projectRoot })
      const invocation = await reader.getByRunId("console-cross-realm")
      expect(invocation).toMatchObject({ status: "completed" })
      await expect(reader.list({ search: "persisted" })).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: invocation?.id })],
      })
      expect(invocation?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({
          "vitehub.agent.configuration": expect.objectContaining({
            agent: { version: "1.0.0" },
            driver: { kind: "run" },
            runtime: { name: "unknown" },
          }),
        }),
        name: "vitehub.agent.configured",
      }))
      expect(agent.invocations).toBe(writer)
      expect(existsSync(join(projectRoot, ".vitehub/data/agent-invocations.sqlite"))).toBe(true)
      expect(existsSync(join(unrelatedCwd, ".vitehub/data/agent-invocations.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("exposes the Console invocation journal through Drizzle and builds invocation URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-drizzle-"))
    try {
      installDefaultJournal(projectRoot)
      const agent = defineAgent({ driver: { run: () => "done" }, runtime: false })
      await runAgentWithContext(agent, { ...runtime("console-drizzle"), agentIdentity: { name: "agent" } }, {})

      const database = await getAgentInvocationsDatabase()
      if (database?.driver !== "libsql") throw new Error("Expected the libSQL journal database.")
      const { db, schema } = database
      const [invocation] = await db.select().from(schema.invocations).orderBy(desc(schema.invocations.sequence)).limit(1)
      if (!invocation) throw new Error("Expected the Console invocation journal to contain the completed invocation.")
      expect(invocation).toMatchObject({ agentName: "agent", status: "completed" })

      const requestless = consoleRuntime.resolve(runtime("console-requestless"))
      await expect(getAgentInvocationsDatabase()).resolves.toBe(database)
      expect(() => requestless.invocationUrl(invocation)).toThrow("Console invocation URLs require `vitehub({ publicUrl })` or a request context")
      vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { agents: { agent: "https://agents.example" } })
      expect(requestless.invocationUrl(invocation)).toBe(
        hostedInvocationUrl("https://agents.example", "agent", invocation.id),
      )
      vi.unstubAllGlobals()

      const resolved = consoleRuntime.resolve({
        ...runtime("console-link"),
        request: new Request("https://chat.example/api/agents/support"),
      })
      expect(resolved.invocationUrl(invocation)).toBe(
        hostedInvocationUrl("https://chat.example", "agent", invocation.id),
      )
      expect(resolved.invocationUrl({ ...invocation, agentName: "team/support" })).toBe(
        hostedInvocationUrl("https://chat.example", "~007400650061006d002f0073007500700070006f00720074", invocation.id),
      )
      expect(resolved.invocationUrl({ ...invocation, agentName: "." })).toBe(
        hostedInvocationUrl("https://chat.example", "~002e", invocation.id),
      )

      vi.stubGlobal("__VITEHUB_APP_BASE_URL__", "/portal/")
      expect(resolved.invocationUrl(invocation)).toBe(
        hostedInvocationUrl("https://chat.example/portal", "agent", invocation.id),
      )
      vi.unstubAllGlobals()
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("uses the configured journal database path relative to the project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-configured-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-configured-cwd-"))
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "file:data/invocations.sqlite")
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      await createDefaultAgentInvocations({ projectRoot }).list()

      expect(existsSync(join(projectRoot, "data/invocations.sqlite"))).toBe(true)
      expect(existsSync(join(projectRoot, ".vitehub/data/agent-invocations.sqlite"))).toBe(false)
      expect(existsSync(join(unrelatedCwd, "data/invocations.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("decodes configured relative journal database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-encoded-project-"))
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "file:data/my%20journal%231.sqlite")
    try {
      const databasePath = join(projectRoot, "data/my journal#1.sqlite")
      await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({ url: pathToFileURL(databasePath).href })
      await createDefaultAgentInvocations({ projectRoot }).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "data/my%20journal%231.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves absolute journal database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-file-url-project-"))
    const databasePath = join(await mkdtemp(join(tmpdir(), "vitehub-console-file-url-data-")), "console #1.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", databaseUrl)
    try {
      await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({ url: databaseUrl })
      await createDefaultAgentInvocations({ projectRoot }).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "console.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(dirname(databasePath), { force: true, recursive: true })
    }
  })

  it("keeps the default journal in memory on Workers without Node globals", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-workers-project-"))
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "")
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" })
    try {
      const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process")
      Reflect.deleteProperty(globalThis, "process")
      let invocations: AgentInvocations
      try {
        invocations = installDefaultJournal(projectRoot)
      }
      finally {
        if (processDescriptor) Object.defineProperty(globalThis, "process", processDescriptor)
      }
      const agent = defineAgent({ driver: { run: () => "in memory" }, runtime: false, version: "1.0.0", invocations })
      await runAgentWithContext(agent, runtime("console-workers"), {})

      await expect(invocations.getByRunId("console-workers")).resolves.toMatchObject({ status: "completed" })
      expect(existsSync(join(projectRoot, ".vitehub"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("recognizes one-slash absolute journal database file URLs", async () => {
    const databasePath = join(tmpdir(), "vitehub-console-one-slash", "console.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href.replace("file:///", "file:/")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", databaseUrl)

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot: join(tmpdir(), "vitehub-console-project") })).resolves.toEqual({
      url: pathToFileURL(databasePath).href,
    })
  })

  it("resolves journal database file URL schemes case-insensitively", async () => {
    const projectRoot = join(tmpdir(), "vitehub-console-uppercase-scheme-project")
    const relativeDatabasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "FILE:data/invocations.sqlite")

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({
      url: pathToFileURL(relativeDatabasePath).href,
    })

    const absoluteDatabasePath = join(tmpdir(), "vitehub-console-uppercase-scheme", "console.sqlite")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", pathToFileURL(absoluteDatabasePath).href.replace("file:", "FILE:"))

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({
      url: pathToFileURL(absoluteDatabasePath).href,
    })
  })

  it("preserves query parameters on configured journal database file URLs", async () => {
    const projectRoot = join(tmpdir(), "vitehub-console-query-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc")

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("excludes fragments from configured relative journal database file paths", async () => {
    const projectRoot = join(tmpdir(), "vitehub-console-fragment-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc#journal")

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("preserves configured in-memory journal database URLs", async () => {
    const databaseUrl = "file::memory:?cache=shared"
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", databaseUrl)

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot: process.cwd() })).resolves.toEqual({ url: databaseUrl })
    await expect(createDefaultAgentInvocations({ projectRoot: process.cwd() }).list()).resolves.toMatchObject({ invocations: [] })
  })

  it("recognizes percent-encoded in-memory journal database URLs", async () => {
    const databaseUrl = "file:%3Amemory%3A?cache=shared"
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", databaseUrl)

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot: process.cwd() })).resolves.toEqual({ url: databaseUrl })
  })

  it("resolves journal database paths that begin with the in-memory name", async () => {
    const projectRoot = join(tmpdir(), "vitehub-console-memory-prefix-project")
    const databasePath = join(projectRoot, ":memory:backup.sqlite")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "file::memory:backup.sqlite")

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot })).resolves.toEqual({ url: pathToFileURL(databasePath).href })
  })

  it("configures the journal database authentication token", async () => {
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_URL", "libsql://console.example.com")
    vi.stubEnv("VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN", "console-token")

    await expect(resolveDefaultAgentInvocationsLocation({ projectRoot: process.cwd() })).resolves.toEqual({
      authToken: "console-token",
      url: "libsql://console.example.com",
    })
  })

  it("validates changed observation limits before reusing the default journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-invalid-retention-"))
    try {
      const installed = installDefaultJournal(projectRoot)
      expect(() => installDefaultJournal(projectRoot, { observations: { maxCount: Number.NaN } }))
        .toThrow("observations.maxCount")
      expect(installDefaultJournal(projectRoot)).toBe(installed)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("retains configured observation sizes and public titles in the default journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-retention-"))
    const observations = { maxCount: 1024, maxStringLength: 131072, maxBytes: 16777216, flushTimeoutMs: 10000 }
    try {
      const invocations = installDefaultJournal(projectRoot, { observations })
      expect(installDefaultJournal(projectRoot, { observations: { ...observations } })).toBe(invocations)
      const text = "x".repeat(120000)
      const agent = defineAgent({
        driver: { run: async (context) => {
          await context.traceLog?.append({
            attributes: { "vitehub.session.title": "Receipt date lookup" },
            name: "agent.title.recorded",
            type: "run",
          })
          return text
        } },
        invocations,
        runtime: false,
      })
      await runAgentWithContext(agent, runtime("console-retention"), { prompt: "Find the receipt date." })
      const invocation = await createDefaultAgentInvocations({ projectRoot }).getByRunId("console-retention")
      expect(invocation?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "vitehub.session.title": "Receipt date lookup" }),
        name: "agent.title.recorded",
      }))
      const result = invocation?.observations.find(observation => observation.name === "agent.invocation.finish")?.attributes?.["result.text"]
      expect(String(result).length).toBe(text.length)
      expect(result).toBe(text)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves progress summaries in the default journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-progress-"))
    try {
      installDefaultJournal(projectRoot)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield {
              data: { revision: 2, summary: "Checking Airtable for assigned tasks.", type: "progress-summary" },
              transient: true,
              type: "data-progress-summary",
            }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgentWithContext(agent, runtime("console-progress-summary"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createDefaultAgentInvocations({ projectRoot }).getByRunId("console-progress-summary")
      expect(invocation?.observations).toContainEqual(expect.objectContaining({
        attributes: expect.objectContaining({
          "content.omitted": expect.not.arrayContaining(["tool.output"]),
          "tool.output": expect.anything(),
          "vitehub.activity.progress": "Checking Airtable for assigned tasks.",
        }),
        name: "agent.tool.finish",
      }))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves failed tool payloads in the default journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-tool-error-"))
    try {
      installDefaultJournal(projectRoot)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield { id: "tool-1", input: { query: "missing" }, name: "lookup", type: "tool-call" }
            yield { error: "Lookup failed", id: "tool-1", name: "lookup", type: "tool-result" }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgentWithContext(agent, runtime("console-tool-error"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createDefaultAgentInvocations({ projectRoot }).getByRunId("console-tool-error")
      const observation = invocation?.observations.find(item => item.name === "agent.tool.error")
      expect(observation).toEqual(expect.objectContaining({
        attributes: expect.objectContaining({ "tool.error": "Lookup failed" }),
        name: "agent.tool.error",
      }))
      expect(observation?.attributes?.["content.omitted"] ?? []).not.toContain("tool.error")
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("accepts public read-only requests", () => {
    expect(() => assertConsoleRequest(event("203.0.113.2"))).not.toThrow()
    expect(() => assertConsoleRequest(event(undefined))).not.toThrow()
  })

  it("marks every console API response as non-cacheable and non-indexable", () => {
    const requestEvent = event("127.0.0.1")

    assertConsoleRequest(requestEvent)

    const responseHeaders = new Map(requestEvent["~standard"].res.headers)
    expect(responseHeaders).toEqual(new Map([
      ["cache-control", "no-store"],
      ["x-content-type-options", "nosniff"],
      ["x-robots-tag", "noindex, nofollow"],
    ]))
  })

  it("treats output without development state as production even with NODE_ENV=development", () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(isConsoleDevelopmentBuild()).toBe(false)
  })

  it("reads the development state that generated output installs", () => {
    installConsoleDevelopment("/tmp/vitehub-console", true)
    expect(isConsoleDevelopmentBuild()).toBe(true)
  })

  it.each(["build", "serve"])("uses generated %s output to select development regardless of NODE_ENV or mode", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-frame-policy-"))
    try {
      const development = command === "serve"
      const mode = development ? "production" : "development"
      const plugin = consoleVitePlugin({ console: productionConsole, sections: [] })
      const config: { nitro?: { plugins?: string[] }, root: string } = { root }
      await callPluginHook(plugin.config, {}, [config, { command, mode }])
      const initial = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")
      await callPluginHook(plugin.configResolved, {}, [config])
      const refreshed = await readFile(consolePluginFile(config.nitro!.plugins), "utf8")

      vi.stubEnv("NODE_ENV", mode)
      for (const generated of [initial, refreshed]) {
        const installation = generated.split("\n").find(line => line.startsWith("installConsoleDevelopment("))
        if (!installation) throw new TypeError("Expected generated development state.")
        runInNewContext(installation, { installConsoleDevelopment })
        expect(isConsoleDevelopmentBuild()).toBe(development)
      }
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
