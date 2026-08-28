import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { defineAgent } from "../src/agent.ts"
import { consoleInvocationsBindingKey, consoleInvocationsBindingRegistryKey, consoleInvocationsIdentityKey, consoleInvocationsIdentityRootKey, consoleInvocationsKey, consoleInvocationsRegistryKey, consoleInvocationsRevisionRegistryKey, consoleInvocationsRootIdentityRegistryKey, consoleInvocationsRootKey, createConsoleInvocationsIdentity, installConsoleInvocationFallback, resolveConsoleInvocations } from "../src/console/internal.ts"
import { serializeConsoleRefresh } from "../src/console/refresh.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureFallbackAgentName, consoleFixtureRevision, parseConsoleFixture } from "../src/console/fixture.ts"
import agentsHandler from "../src/console/runtime/server/agents.get.ts"
import { installConsoleAgentDefinitions, installConsoleAgents } from "../src/console/runtime/server/agents.ts"
import { createConsoleFixtureInvocations, createConsoleInvocations, installConsoleFixtureInvocations, installConsoleInvocations, resolveConsoleDatabaseOptions } from "../src/console/runtime/server/invocations.ts"
import invocationsHandler from "../src/console/runtime/server/invocations.get.ts"
import consolePageHandler from "../src/console/runtime/server/page.get.ts"
import { assertConsoleRequest } from "../src/console/runtime/server/request.ts"
import searchHandler from "../src/console/runtime/server/search.get.ts"
import { consoleSearch } from "../src/console/runtime/server/search.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin, updateConsoleInvocationRootState } from "../src/console/vite.ts"

import { runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import type { AgentInvocations, AgentRuntimeContext } from "@vite-hub/agent"
import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

type ConsoleGlobal = typeof globalThis & Record<symbol, AgentInvocations | string | undefined>

const scope = globalThis as ConsoleGlobal
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This test double only needs identity; no journal method is invoked through it.
const fakeInvocations = (name: string) => ({ name }) as unknown as AgentInvocations

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

function event(address: string | undefined, method = "GET"): ConsoleRequestEvent {
  const headers = new Headers({ host: "localhost" })
  return {
    headers,
    method,
    node: { req: { method, socket: { remoteAddress: address }, url: "http://localhost/_vitehub" } },
    req: { method, url: "http://localhost/_vitehub" },
  }
}

function runtime(runId: string): AgentRuntimeContext {
  return {
    memo: vi.fn(),
    run: { runId },
    runtime: "unknown",
    waitUntil: vi.fn(),
  }
}

afterEach(() => {
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
  Reflect.deleteProperty(process, consoleInvocationsRootKey)
  Reflect.deleteProperty(process, consoleInvocationsRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRootIdentityRegistryKey)
  Reflect.deleteProperty(process, consoleInvocationsRevisionRegistryKey)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("Agent invocation console", () => {
  it("loads versioned invocation fixtures into an in-memory journal", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-"))
    try {
      const file = join(root, "console.fixture.json")
      await writeFile(file, JSON.stringify({
        invocations: [{
          agentName: "support",
          createdAt: "2026-08-27T10:00:00.000Z",
          id: "fixture-invocation",
          observations: [{
            attributes: { "message.content": "Fixture reply", "message.role": "assistant" },
            name: "agent.message",
            sequence: 1,
            timestamp: "2026-08-27T10:00:01.000Z",
            type: "run",
          }],
          status: "completed",
          traceId: "fixture-trace",
          updatedAt: "2026-08-27T10:00:01.000Z",
        }],
        version: 1,
      }))

      const invocations = createConsoleFixtureInvocations(file)

      await expect(invocations.get("fixture-invocation")).resolves.toMatchObject({
        agentName: "support",
        observations: [expect.objectContaining({ name: "agent.message" })],
      })
      await expect(invocations.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "fixture-invocation" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("replaces an installed journal when the fixture identity changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-switch-"))
    const fixture = (id: string) => ({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id,
        observations: [],
        status: "completed",
        traceId: `${id}-trace`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })
    try {
      const firstFile = join(root, "first.json")
      const secondFile = join(root, "second.json")
      await writeFile(firstFile, JSON.stringify(fixture("first")))
      await writeFile(secondFile, JSON.stringify(fixture("second")))

      const first = installConsoleFixtureInvocations(root, firstFile)
      const second = installConsoleFixtureInvocations(root, secondFile)

      expect(second).not.toBe(first)
      await expect(second.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "second" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("replaces an installed journal when a fixture is rewritten in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-rewrite-"))
    const fixture = (id: string) => ({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id,
        observations: [],
        status: "completed",
        traceId: `${id}-trace`,
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })
    try {
      const file = join(root, "fixture.json")
      const firstFixture = parseConsoleFixture(fixture("first"))
      const firstRevision = consoleFixtureRevision(firstFixture)
      await writeFile(file, JSON.stringify(firstFixture))
      const first = installConsoleFixtureInvocations(root, file)
      const existingRealm = {
        process,
        [consoleInvocationsIdentityKey]: createConsoleInvocationsIdentity(root, file, firstRevision),
        [consoleInvocationsIdentityRootKey]: root,
        [consoleInvocationsRootKey]: root,
      }

      await writeFile(file, JSON.stringify(fixture("second")))
      const second = installConsoleFixtureInvocations(root, file)

      expect(second).not.toBe(first)
      expect(resolveConsoleInvocations(existingRealm)).toBe(first)
      expect(resolveConsoleInvocations()).toBe(second)
      expect(Reflect.get(process, consoleInvocationsRegistryKey).size).toBe(2)
      await expect(second.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "second" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("installs a validated generated snapshot after the fixture changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-snapshot-"))
    try {
      const file = join(root, "fixture.json")
      const fixture = parseConsoleFixture(fixtureDocument("generated"))
      await writeFile(file, JSON.stringify(fixture))
      await writeFile(file, "not json")

      const invocations = installConsoleFixtureInvocations(root, file, fixture, consoleFixtureRevision(fixture))

      await expect(invocations.list()).resolves.toMatchObject({
        invocations: [expect.objectContaining({ id: "generated" })],
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects malformed and duplicate fixture records", () => {
    expect(parseConsoleFixture({
      invocations: [{
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "anonymous",
        observations: [],
        status: "completed",
        traceId: "anonymous-trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    }).invocations[0]?.agentName).toBe(consoleFixtureFallbackAgentName)
    expect(() => parseConsoleFixture({ invocations: [], version: 2 })).toThrow("version must be 1")
    expect(() => parseConsoleFixture({
      invocations: [0, 1].map(() => ({
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "duplicate",
        observations: [],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      })),
      version: 1,
    })).toThrow("duplicate invocation id")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "missing-observation-fields",
        observations: [{ sequence: 0, type: "run" }],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow("observations[0].name must be a non-empty string")
    expect(() => parseConsoleFixture({
      invocations: [{
        agentName: "support",
        createdAt: "2026-08-27T10:00:00.000Z",
        id: "missing-observation-timestamp",
        observations: [{ name: "agent.message", sequence: 0, type: "run" }],
        status: "completed",
        traceId: "trace",
        updatedAt: "2026-08-27T10:00:00.000Z",
      }],
      version: 1,
    })).toThrow("observations[0].timestamp must be a non-empty string")
  })

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

  it("registers the standalone console UI and invocation API with Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node" })
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

      expect(config.nitro.handlers.map(handler => handler.route)).toEqual([
        "/api/_vitehub/console/agents",
        "/api/_vitehub/console/invocations",
        "/api/_vitehub/console/invocations/:id",
        "/api/_vitehub/console/search",
        "/_vitehub",
        "/_vitehub/**",
      ])
      expect(config.nitro.publicAssets).toEqual([
        expect.objectContaining({ baseURL: "/_vitehub/assets" }),
      ])
      expect(config.nitro.plugins).toEqual([resolve(root, ".vitehub/nitro/console/plugin.mjs")])
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `const vitehubConsoleInvocations = installConsoleInvocations(${JSON.stringify(root)})`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(
        `fallbackName: "review"`,
      )
      await expect(readFile(config.nitro.plugins[0]!, "utf8")).resolves.toContain(`from "file://`)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects production console builds without durable local storage", async () => {
    const plugin = consoleVitePlugin({ preset: "cloudflare" })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a console config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook

    await expect(Reflect.apply(configHandler, {}, [{ root: process.cwd() }, {
      command: "build",
      mode: "production",
    }])).rejects.toThrow('Console currently requires preset: "node" for production')
  })

  it("rejects a bare production Console boolean", async () => {
    const plugin = consoleVitePlugin({ console: true, preset: "node" })
    const configHook = plugin.config
    if (!configHook) throw new TypeError("Expected a console config hook.")
    const configHandler = "handler" in configHook ? configHook.handler : configHook

    await expect(Reflect.apply(configHandler, {}, [{ root: process.cwd() }, {
      command: "build",
      mode: "production",
    }])).rejects.toThrow("console: true is development-only")
  })

  it("requires ViteHub Auth authorize policies for both production route groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-auth-host-"))
    const auth = (routes: ResolvedAuthViteConfig["access"]["routes"]): ResolvedAuthViteConfig => ({
      access: { routes },
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
      rootDir: root,
      route: "/api/auth",
      secondaryStorage: false,
    })
    try {
      const missingApi = consoleVitePlugin({
        console: { access: "auth" },
        preset: "node",
        resolveAuthConfig: () => auth([{ authorize: true, route: "/_vitehub/**" }]),
      })
      const missingHook = missingApi.config
      if (!missingHook) throw new TypeError("Expected a console config hook.")
      const missingHandler = "handler" in missingHook ? missingHook.handler : missingHook
      await expect(Reflect.apply(missingHandler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("/api/_vitehub/console/**")

      const protectedConsole = consoleVitePlugin({
        console: { access: "auth" },
        preset: "node",
        resolveAuthConfig: () => auth([
          { authorize: true, route: "/_vitehub/**" },
          { authorize: true, route: "/api/_vitehub/console/**" },
        ]),
      })
      const protectedHook = protectedConsole.config
      if (!protectedHook) throw new TypeError("Expected a console config hook.")
      const protectedHandler = "handler" in protectedHook ? protectedHook.handler : protectedHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }
      await Reflect.apply(protectedHandler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toEqual(expect.arrayContaining([
        expect.objectContaining({ route: "/_vitehub/**" }),
        expect.objectContaining({ route: "/api/_vitehub/console/agents" }),
      ]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("accepts explicit host-managed production exposure", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-managed-host-"))
    try {
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub/**" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps the local console available during development for every preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-dev-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ preset: "cloudflare" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { handlers: Array<{ route: string }> }, root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "serve", mode: "development" }])

      expect(config.nitro?.handlers).toContainEqual(expect.objectContaining({ route: "/_vitehub" }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("generates a fixture-backed journal only for development servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-host-"))
    const fixtureRoot = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-data-"))
    try {
      const fixture = join(fixtureRoot, "console.fixture.json")
      await writeFile(join(root, "package.json"), "{}\n")
      const fixtureWithPrototypeData = JSON.parse(`{
        "version": 1,
        "invocations": [{
          "createdAt": "2026-08-27T10:00:00.000Z",
          "id": "prototype-data",
          "observations": [{
            "attributes": { "__proto__": { "preserved": true } },
            "name": "agent.message",
            "sequence": 0,
            "timestamp": "2026-08-27T10:00:00.000Z",
            "type": "run"
          }],
          "status": "completed",
          "traceId": "prototype-data-trace",
          "updatedAt": "2026-08-27T10:00:00.000Z"
        }]
      }`)
      await writeFile(fixture, JSON.stringify(fixtureWithPrototypeData))
      vi.stubEnv(consoleFixtureEnvironmentVariable, fixture)
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config: { nitro?: { plugins?: string[] }, root: string } = { root }

      await Reflect.apply(configHandler, {}, [config, { command: "serve", mode: "development" }])

      const generated = await readFile(config.nitro?.plugins?.[0] ?? "", "utf8")
      expect(generated).toContain(`installConsoleFixtureInvocations(${JSON.stringify(root)}, ${JSON.stringify(fixture)}, `)
      expect(generated).toContain("JSON.parse(")
      const generatedInstallation = generated.split("\n").find(line => line.startsWith("const vitehubConsoleInvocations"))
      if (!generatedInstallation) throw new TypeError("Expected a generated fixture installation.")
      let generatedSnapshot: unknown
      runInNewContext(generatedInstallation, {
        installConsoleFixtureInvocations: (_root: string, _file: string, snapshot: unknown) => {
          generatedSnapshot = snapshot
        },
      })
      // SAFETY: The generated installation was produced from the fully validated fixture above.
      const generatedAttributes = (generatedSnapshot as { invocations: Array<{ observations: Array<{ attributes: object }> }> })
        .invocations[0]!.observations[0]!.attributes
      expect(Object.hasOwn(generatedAttributes, "__proto__")).toBe(true)
      expect(Reflect.get(generatedAttributes, "__proto__")).toEqual({ preserved: true })

      const listeners = new Map<string, () => Promise<void>>()
      const logger = { error: vi.fn() }
      const add = vi.fn()
      const configureServerHook = plugin.configureServer
      if (!configureServerHook) throw new TypeError("Expected a configureServer hook.")
      const configureServer = "handler" in configureServerHook
        ? configureServerHook.handler
        : configureServerHook
      await Reflect.apply(configureServer, {}, [{ config: { logger }, watcher: { add, on: (event: string, callback: () => Promise<void>) => listeners.set(event, callback) } }])
      expect(add).toHaveBeenCalledWith(fixture)
      await writeFile(fixture, JSON.stringify(fixtureDocument("replacement")))
      await listeners.get("change")?.()
      const refreshed = await readFile(config.nitro?.plugins?.[0] ?? "", "utf8")
      expect(refreshed).not.toBe(generated)

      await writeFile(fixture, "not json")
      await expect(listeners.get("change")?.()).resolves.toBeUndefined()
      await expect(readFile(config.nitro?.plugins?.[0] ?? "", "utf8")).resolves.toBe(refreshed)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not refresh Console development state"))

      await rm(fixture)
      await expect(listeners.get("unlink")?.()).resolves.toBeUndefined()
      await expect(readFile(config.nitro?.plugins?.[0] ?? "", "utf8")).resolves.toBe(refreshed)
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not refresh Console development state"))

      await writeFile(fixture, JSON.stringify(fixtureDocument("restored")))
      await listeners.get("add")?.()
      await expect(readFile(config.nitro?.plugins?.[0] ?? "", "utf8")).resolves.not.toBe(refreshed)

      await expect(Reflect.apply(configHandler, {}, [{ root }, { command: "build", mode: "production" }]))
        .rejects.toThrow("Console fixture mode is development-only")
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(fixtureRoot, { force: true, recursive: true })
    }
  })

  it("ignores inherited fixtures during Vite CLI discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-cli-discovery-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const generatedPlugin = resolve(root, ".vitehub/nitro/console/plugin.mjs")
      await mkdir(resolve(generatedPlugin, ".."), { recursive: true })
      await writeFile(generatedPlugin, "// active fixture plugin\n")
      vi.stubEnv(consoleFixtureEnvironmentVariable, join(root, "missing.fixture.json"))
      const plugin = consoleVitePlugin({ preset: "node" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook

      await expect(Reflect.apply(configHandler, {}, [
        { root, vitehubCliDiscovery: true },
        { command: "serve", mode: "development" },
      ])).resolves.toBeUndefined()
      const configResolvedHook = plugin.configResolved
      if (!configResolvedHook) throw new TypeError("Expected a configResolved hook.")
      const configResolvedHandler = "handler" in configResolvedHook ? configResolvedHook.handler : configResolvedHook
      await Reflect.apply(configResolvedHandler, {}, [{ root }])
      await expect(readFile(generatedPlugin, "utf8")).resolves.toBe("// active fixture plugin\n")
    }
    finally {
      vi.unstubAllEnvs()
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

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["billing"],
    })

    scope[consoleInvocationsRootKey] = "/first"
    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["review", "support"] })
  })

  it("rebinds already evaluated Agent realms to a refreshed fixture revision", async () => {
    const projectRoot = "/project"
    const fixture = "/fixture.json"
    const firstIdentity = createConsoleInvocationsIdentity(projectRoot, fixture, "first")
    const secondIdentity = createConsoleInvocationsIdentity(projectRoot, fixture, "second")
    const first = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const second = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity, "first")

    const state = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(state, projectRoot, firstIdentity)
    const plugin = consoleInvocationRootPlugin(projectRoot, firstIdentity, state)
    const resolved = { id: "/agent.ts" }
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
    const buildStart = plugin.buildStart as unknown as (this: { resolve: ReturnType<typeof vi.fn> }) => Promise<void>
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This focused test invokes Vite hooks with structural arguments.
    const transform = plugin.transform as unknown as (code: string, id: string) => string | undefined
    await Reflect.apply(buildStart, { resolve: vi.fn().mockResolvedValue(resolved) }, [])
    const transformed = transform("", resolved.id)
    // SAFETY: The generated script returns the isolated realm used by this focused binding test.
    const realm = runInNewContext(`${transformed}\nglobalThis`, { process }) as object
    expect(resolveConsoleInvocations(realm)).toBe(first)

    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity, "second")
    updateConsoleInvocationRootState(state, projectRoot, secondIdentity)

    expect(resolveConsoleInvocations(realm)).toBe(second)
  })

  it("keeps configured identities across concurrent same-root runtimes", async () => {
    const projectRoot = "/project"
    const firstIdentity = "fixture:/project:/fixture.json:first"
    const secondIdentity = "fixture:/project:/fixture.json:second"
    const thirdIdentity = "fixture:/project:/fixture.json:third"
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const third = fakeInvocations("third")
    installConsoleInvocationFallback(first, projectRoot, globalThis, firstIdentity, "first")
    const firstState = { identity: firstIdentity, projectRoot }
    updateConsoleInvocationRootState(firstState, projectRoot, firstIdentity)
    const firstPlugin = consoleInvocationRootPlugin(projectRoot, firstIdentity, firstState)
    installConsoleInvocationFallback(second, projectRoot, globalThis, secondIdentity, "second")
    const secondState = { identity: secondIdentity, projectRoot }
    updateConsoleInvocationRootState(secondState, projectRoot, secondIdentity)
    const secondPlugin = consoleInvocationRootPlugin(projectRoot, secondIdentity, secondState)
    const resolved = { id: "/agent.ts" }
    // SAFETY: This focused test invokes Vite hooks with structural arguments.
    const firstBuildStart = firstPlugin.buildStart as unknown as (this: { resolve: ReturnType<typeof vi.fn> }) => Promise<void>
    // SAFETY: This focused test invokes Vite hooks with structural arguments.
    const secondBuildStart = secondPlugin.buildStart as unknown as (this: { resolve: ReturnType<typeof vi.fn> }) => Promise<void>
    // SAFETY: This focused test invokes Vite hooks with structural arguments.
    const firstTransform = firstPlugin.transform as unknown as (code: string, id: string) => string
    // SAFETY: This focused test invokes Vite hooks with structural arguments.
    const secondTransform = secondPlugin.transform as unknown as (code: string, id: string) => string
    await Reflect.apply(firstBuildStart, { resolve: vi.fn().mockResolvedValue(resolved) }, [])
    await Reflect.apply(secondBuildStart, { resolve: vi.fn().mockResolvedValue(resolved) }, [])

    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const firstRealm = runInNewContext(`${firstTransform("", resolved.id)}\nglobalThis`, { process }) as object
    // SAFETY: Each generated script returns the isolated realm used by this focused binding test.
    const secondRealm = runInNewContext(`${secondTransform("", resolved.id)}\nglobalThis`, { process }) as object

    expect(resolveConsoleInvocations(firstRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)

    installConsoleInvocationFallback(third, projectRoot, globalThis, thirdIdentity, "third")
    updateConsoleInvocationRootState(firstState, projectRoot, thirdIdentity)

    expect(resolveConsoleInvocations(firstRealm)).toBe(third)
    expect(resolveConsoleInvocations(secondRealm)).toBe(second)
  })

  it("keeps persisted Agent names alongside discovered definitions", async () => {
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

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["archived", "current"],
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
    ], invocations)

    expect(definition.invocations).toBe(invocations)
    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["support"] })
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
    ], consoleInvocations)

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("preserves an Agent invocation journal assigned after definition", () => {
    const explicitInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const consoleInvocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "support" })
    definition.invocations = explicitInvocations

    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], consoleInvocations)

    expect(definition.invocations).toBe(explicitInvocations)
  })

  it("uses the discovered name when an explicit Agent Definition name is blank", async () => {
    const definition = defineAgent({ driver: { run: () => "ok" }, name: "   " })
    expect(definition.name).toBe("")
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], invocations)

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["help"] })
  })

  it("rejects Agent names beyond the persisted identity limit", () => {
    expect(() => defineAgent({ driver: { run: () => "ok" }, name: "a".repeat(513) }))
      .toThrow("Agent names cannot exceed 512 characters")
  })

  it("keeps colliding discovered route names until definitions resolve", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-collision-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await mkdir(join(root, "server", "agents"), { recursive: true })
      await writeFile(join(root, "server", "agents", "review.ts"), "export default {}\n")
      const plugin = consoleVitePlugin({ console: { exposure: "host-managed" }, preset: "node" })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      const config = { root }
      await Reflect.apply(configHandler, {}, [config, { command: "build", mode: "production" }])
      const generated = await readFile(resolve(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
      expect(generated.match(/fallbackName: "review"/g)).toHaveLength(2)
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
      const plugin = consoleVitePlugin()
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

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({
      agents: ["archived", "current"],
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
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?agent=review"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationsHandler(requestEvent)).resolves.toMatchObject({
      invocations: [{ agentName: "review" }],
    })
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

    // SAFETY: the test mounts the generated Nitro handler on the equivalent H3 route contract.
    const app = new H3().get("/search", searchHandler as never)
    const response = await app.request("/search?limit=12&search=merged%20via")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "matching-invocation" })],
      nextCursor: null,
    })

    const invalidResponse = await app.request("/search?search=one&search=two")
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
    const requestEvent = event("127.0.0.1")
    const url = `http://localhost/api/_vitehub/console/invocations?agent=${agentName}`
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationsHandler(requestEvent)).resolves.toMatchObject({
      invocations: [{ agentName }],
    })
  })

  it("refreshes invocation summaries in one request without observations", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const id of ["inv-1", "inv-2"]) {
      store.create({
        createdAt: "2026-08-23T12:00:00.000Z",
        id,
        observations: [{ name: "private", sequence: 1, timestamp: "2026-08-23T12:00:00.000Z", type: "run" }],
        status: "running",
        traceId: `trace-${id}`,
        updatedAt: "2026-08-23T12:00:00.000Z",
      })
    }
    installConsoleInvocationFallback(defineAgentInvocations({ store }), process.cwd())
    const requestEvent = event("127.0.0.1")
    const url = "http://localhost/api/_vitehub/console/invocations?id=inv-1&id=inv-2"
    requestEvent.node!.req!.url = url
    requestEvent.req!.url = url

    await expect(invocationsHandler(requestEvent)).resolves.toMatchObject({
      invocations: [{ id: "inv-1" }, { id: "inv-2" }],
    })
    expect(await invocationsHandler(requestEvent)).toEqual({
      invocations: [
        expect.not.objectContaining({ observations: expect.anything() }),
        expect.not.objectContaining({ observations: expect.anything() }),
      ],
    })
  })

  it("supplies the console journal to framework Agent Definitions without a store", () => {
    const fallback = fakeInvocations("console")
    scope[consoleInvocationsKey] = fallback

    const agent = defineAgent({ driver: { run: () => "ok" } })

    expect(agent.invocations).toBe(fallback)
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

    expect(resolveConsoleInvocations({
      process,
      [consoleInvocationsRootKey]: "/project",
    })).toBe(fallback)
  })

  it("resolves the current journal identity from a project-root-only Agent realm", () => {
    const fixture = fakeInvocations("fixture")
    installConsoleInvocationFallback(fixture, "/project", { process }, "fixture:/project:/fixture.json")

    expect(Reflect.get(process, consoleInvocationsRootIdentityRegistryKey).get("/project")).toBe("fixture:/project:/fixture.json")
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(fixture)
  })

  it("keeps each same-root runtime bound to its installed journal identity", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process }
    const secondScope = { process }

    installConsoleInvocationFallback(first, "/project", firstScope, "fixture:/project:/first.json")
    installConsoleInvocationFallback(second, "/project", secondScope, "fixture:/project:/second.json")

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(second)
  })

  it("keeps concurrent fixture revisions bound to their runtime journal", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process }
    const secondScope = { process }
    const firstIdentity = createConsoleInvocationsIdentity("/project", "/fixture.json", "first-revision")
    const secondIdentity = createConsoleInvocationsIdentity("/project", "/fixture.json", "second-revision")

    installConsoleInvocationFallback(first, "/project", firstScope, firstIdentity, "first-revision")
    installConsoleInvocationFallback(second, "/project", secondScope, secondIdentity, "second-revision")

    const firstAgentRealm = {
      process,
      [consoleInvocationsIdentityKey]: firstIdentity,
      [consoleInvocationsIdentityRootKey]: "/project",
      [consoleInvocationsRootKey]: "/project",
    }
    const secondAgentRealm = {
      process,
      [consoleInvocationsIdentityKey]: secondIdentity,
      [consoleInvocationsIdentityRootKey]: "/project",
      [consoleInvocationsRootKey]: "/project",
    }

    expect(resolveConsoleInvocations(firstScope)).toBe(first)
    expect(resolveConsoleInvocations(secondScope)).toBe(second)
    expect(resolveConsoleInvocations(firstAgentRealm)).toBe(first)
    expect(resolveConsoleInvocations(secondAgentRealm)).toBe(second)
    expect(resolveConsoleInvocations({ process, [consoleInvocationsRootKey]: "/project" })).toBe(second)
  })

  it("keeps process-shared journals scoped to their project root", () => {
    const first = fakeInvocations("first")
    const second = fakeInvocations("second")
    const firstScope = { process, [consoleInvocationsRootKey]: "/first" }
    const secondScope = { process, [consoleInvocationsRootKey]: "/second" }

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

    // doctor-disable-next-line typescript/evidence/no-object-parameters -- VM contexts accept object realms and the test only checks injected symbol state.
    const bind = async (projectRoot: string, realm: object, identity?: string) => {
      const plugin = consoleInvocationRootPlugin(projectRoot, identity)
      // SAFETY: The console plugin declares this environment predicate on its Vite Plugin contract.
      const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with a focused fake context.
      const buildStart = plugin.buildStart as unknown as (this: typeof context) => Promise<void>
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: This test invokes a Vite object hook with a focused fake context.
      const resolveId = plugin.resolveId as unknown as (
        // doctor-disable-next-line typescript/evidence/no-object-parameters -- The fake Vite hook context is intentionally structural.
        this: object,
        source: string,
        importer: string | undefined,
        options: { isEntry: boolean },
      ) => Promise<{ external?: boolean, id: string } | undefined>
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
      const resolved = await Reflect.apply(resolveId, context, ["vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false }])
      const code = await transform("globalThis.agentModuleEvaluated = true", resolvedAgentEntry)
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", undefined, { skipSelf: true })
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false, skipSelf: true })
      expect(resolved).toEqual({ external: false, id: resolvedAgentEntry })
      // SAFETY: The evaluated fixture explicitly returns its VM global object.
      return runInNewContext(`${code}\nglobalThis`, realm) as object
    }

    expect(Reflect.has(firstAgentRealm, consoleInvocationsRootKey)).toBe(false)
    expect(Reflect.has(secondAgentRealm, consoleInvocationsRootKey)).toBe(false)
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
    const firstIdentity = "fixture:/project:/first.json"
    const secondIdentity = "fixture:/project:/second.json"
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
    await writeFile(join(root, "agent-root.ts"), [
      `import ${JSON.stringify(frameworkAgentEntry)}`,
      'export const projectRoot = globalThis[Symbol.for("vitehub.console.invocations.root")]',
      "",
    ].join("\n"))
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

  it("anchors the durable journal to the project root and shares it between runtime instances", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-cwd-"))
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      const writer = installConsoleInvocations(projectRoot)
      const agent = defineAgent({ driver: { run: () => "persisted" }, runtime: false, version: "1.0.0" })
      await runAgent(agent, runtime("console-cross-realm"), {})

      const reader = createConsoleInvocations(projectRoot)
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
      expect(existsSync(join(projectRoot, ".vitehub/data/console.sqlite"))).toBe(true)
      expect(existsSync(join(unrelatedCwd, ".vitehub/data/console.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("uses the configured Console database path relative to the project root", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-configured-project-"))
    const unrelatedCwd = await mkdtemp(join(tmpdir(), "vitehub-console-configured-cwd-"))
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite")
    vi.spyOn(process, "cwd").mockReturnValue(unrelatedCwd)
    try {
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(join(projectRoot, "data/invocations.sqlite"))).toBe(true)
      expect(existsSync(join(projectRoot, ".vitehub/data/console.sqlite"))).toBe(false)
      expect(existsSync(join(unrelatedCwd, "data/invocations.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(unrelatedCwd, { force: true, recursive: true })
    }
  })

  it("decodes configured relative Console database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-encoded-project-"))
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/my%20journal%231.sqlite")
    try {
      const databasePath = join(projectRoot, "data/my journal#1.sqlite")
      expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: pathToFileURL(databasePath).href })
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "data/my%20journal%231.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("preserves absolute Console database file URLs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-file-url-project-"))
    const databasePath = join(await mkdtemp(join(tmpdir(), "vitehub-console-file-url-data-")), "console #1.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)
    try {
      expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: databaseUrl })
      await createConsoleInvocations(projectRoot).list()

      expect(existsSync(databasePath)).toBe(true)
      expect(existsSync(join(projectRoot, "console.sqlite"))).toBe(false)
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
      await rm(dirname(databasePath), { force: true, recursive: true })
    }
  })

  it("recognizes one-slash absolute Console database file URLs", () => {
    const databasePath = join(tmpdir(), "vitehub-console-one-slash", "console.sqlite")
    const databaseUrl = pathToFileURL(databasePath).href.replace("file:///", "file:/")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(join(tmpdir(), "vitehub-console-project"))).toEqual({
      url: pathToFileURL(databasePath).href,
    })
  })

  it("resolves Console database file URL schemes case-insensitively", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-uppercase-scheme-project")
    const relativeDatabasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "FILE:data/invocations.sqlite")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: pathToFileURL(relativeDatabasePath).href,
    })

    const absoluteDatabasePath = join(tmpdir(), "vitehub-console-uppercase-scheme", "console.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", pathToFileURL(absoluteDatabasePath).href.replace("file:", "FILE:"))

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: pathToFileURL(absoluteDatabasePath).href,
    })
  })

  it("preserves query parameters on configured Console database file URLs", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-query-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("excludes fragments from configured relative Console database file paths", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-fragment-project")
    const databasePath = join(projectRoot, "data/invocations.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file:data/invocations.sqlite?mode=rwc#journal")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({
      url: `${pathToFileURL(databasePath).href}?mode=rwc`,
    })
  })

  it("preserves configured in-memory Console database URLs", async () => {
    const databaseUrl = "file::memory:?cache=shared"
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({ url: databaseUrl })
    await expect(createConsoleInvocations(process.cwd()).list()).resolves.toMatchObject({ invocations: [] })
  })

  it("recognizes percent-encoded in-memory Console database URLs", () => {
    const databaseUrl = "file:%3Amemory%3A?cache=shared"
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", databaseUrl)

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({ url: databaseUrl })
  })

  it("resolves Console database paths that begin with the in-memory name", () => {
    const projectRoot = join(tmpdir(), "vitehub-console-memory-prefix-project")
    const databasePath = join(projectRoot, ":memory:backup.sqlite")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "file::memory:backup.sqlite")

    expect(resolveConsoleDatabaseOptions(projectRoot)).toEqual({ url: pathToFileURL(databasePath).href })
  })

  it("configures the Console database authentication token", () => {
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_URL", "libsql://console.example.com")
    vi.stubEnv("VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN", "console-token")

    expect(resolveConsoleDatabaseOptions(process.cwd())).toEqual({
      authToken: "console-token",
      url: "libsql://console.example.com",
    })
  })

  it("preserves progress summaries in the console journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-progress-"))
    try {
      installConsoleInvocations(projectRoot)
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
      const result = await runAgent(agent, runtime("console-progress-summary"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createConsoleInvocations(projectRoot).getByRunId("console-progress-summary")
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

  it("preserves failed tool payloads in the console journal", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-tool-error-"))
    try {
      installConsoleInvocations(projectRoot)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield { id: "tool-1", input: { query: "missing" }, name: "lookup", type: "tool-call" }
            yield { error: "Lookup failed", id: "tool-1", name: "lookup", type: "tool-result" }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgent(agent, runtime("console-tool-error"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await createConsoleInvocations(projectRoot).getByRunId("console-tool-error")
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

  it("preserves tool payloads in fixture-backed console journals", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-console-fixture-tools-"))
    try {
      const file = join(projectRoot, "console.fixture.json")
      await writeFile(file, JSON.stringify({ invocations: [], version: 1 }))
      const invocations = installConsoleFixtureInvocations(projectRoot, file)
      const agent = defineAgent({
        driver: { run: () => (async function* () {
            yield { id: "tool-1", input: { query: "fixture" }, name: "lookup", type: "tool-call" }
            yield { id: "tool-1", name: "lookup", output: { answer: "preserved" }, type: "tool-result" }
            yield { type: "finish" }
          })() },
        runtime: false,
      })
      const result = await runAgent(agent, runtime("console-fixture-tool"), {})
      // SAFETY: This Driver fixture always returns the async generator defined above.
      for await (const _event of result as AsyncIterable<unknown>) {}

      const invocation = await invocations.getByRunId("console-fixture-tool")
      expect(invocation?.observations).toEqual(expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({ "tool.input": { query: "fixture" } }),
          name: "agent.tool.start",
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({ "tool.output": { answer: "preserved" } }),
          name: "agent.tool.finish",
        }),
      ]))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("accepts public read-only requests", () => {
    expect(() => assertConsoleRequest(event("203.0.113.2"))).not.toThrow()
    expect(() => assertConsoleRequest(event(undefined))).not.toThrow()
  })

  it("marks every console API response as non-cacheable", () => {
    const responseHeaders = new Map<string, string>()
    const requestEvent = event("127.0.0.1")
    requestEvent.node!.res = {
      setHeader: (name, value) => responseHeaders.set(name, value),
    }

    assertConsoleRequest(requestEvent)

    expect(responseHeaders).toEqual(new Map([
      ["cache-control", "no-store"],
      ["x-content-type-options", "nosniff"],
    ]))
  })

  it("serves the standalone shell with a restrictive non-cacheable policy", () => {
    const response = consolePageHandler(event("127.0.0.1"))

    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("content-security-policy")).toContain("base-uri 'none'")
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'")
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
