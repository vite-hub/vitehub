import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { defineAgent } from "../src/agent.ts"
import { consoleInvocationsKey, consoleInvocationsRegistryKey, consoleInvocationsRootKey, installConsoleInvocationFallback, resolveConsoleInvocations } from "../src/console/internal.ts"
import { serializeConsoleRefresh } from "../src/console/refresh.ts"
import agentsHandler from "../src/console/runtime/server/agents.get.ts"
import { installConsoleAgentDefinitions, installConsoleAgents } from "../src/console/runtime/server/agents.ts"
import { createConsoleInvocations, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import invocationsHandler from "../src/console/runtime/server/invocations.get.ts"
import { assertConsoleRequest } from "../src/console/runtime/server/request.ts"
import { consoleInvocationRootPlugin, consoleVitePlugin } from "../src/console/vite.ts"

import { runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import type { AgentInvocations, AgentRuntimeContext } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

type ConsoleGlobal = typeof globalThis & Record<symbol, AgentInvocations | string | undefined>

const scope = globalThis as ConsoleGlobal
// doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This test double only needs identity; no journal method is invoked through it.
const fakeInvocations = (name: string) => ({ name }) as unknown as AgentInvocations

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
  delete scope[consoleInvocationsRootKey]
  Reflect.deleteProperty(process, consoleInvocationsKey)
  Reflect.deleteProperty(process, consoleInvocationsRootKey)
  Reflect.deleteProperty(process, consoleInvocationsRegistryKey)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

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

  it("registers the standalone console UI and invocation API with Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-host-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      await writeFile(join(root, "review.agent.ts"), "export default {}\n")
      await writeFile(join(root, "support.agent.ts"), "export default {}\n")
      const plugin = consoleVitePlugin()
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
    const invocations = defineAgentInvocations({ store: createMemoryAgentInvocationStore() })
    installConsoleInvocationFallback(invocations, process.cwd())
    installConsoleAgentDefinitions([
      { definition: { default: definition }, fallbackName: "help" },
    ], invocations)

    await expect(agentsHandler(event("127.0.0.1"))).resolves.toEqual({ agents: ["support"] })
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
      const plugin = consoleVitePlugin()
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
    const bind = async (projectRoot: string, realm: object) => {
      const plugin = consoleInvocationRootPlugin(projectRoot)
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
          "content.omitted": expect.arrayContaining(["tool.output", "vitehub.activity.body", "vitehub.activity.title"]),
          "vitehub.activity.progress": "Checking Airtable for assigned tasks.",
        }),
        name: "agent.tool.finish",
      }))
    }
    finally {
      await rm(projectRoot, { force: true, recursive: true })
    }
  })

  it("accepts public read-only requests", () => {
    expect(() => assertConsoleRequest(event("203.0.113.2"))).not.toThrow()
    expect(() => assertConsoleRequest(event(undefined))).not.toThrow()
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
