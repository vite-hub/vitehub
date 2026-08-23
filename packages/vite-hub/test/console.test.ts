import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "vite"

import { defineAgent } from "../src/agent.ts"
import { consoleInvocationsKey, consoleInvocationsRegistryKey, consoleInvocationsRootKey, installConsoleInvocationFallback, resolveConsoleInvocations } from "../src/console/internal.ts"
import { createConsoleInvocations, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import invocationsHandler from "../src/console/runtime/server/invocations.get.ts"
import { assertLocalConsolePeer, assertLocalConsoleRequest } from "../src/console/runtime/server/local-request.ts"
import { CONSOLE_SESSION_LOOKUP_PAGE_LIMIT, createConsoleRequest, groupConsoleSessions, shouldLoadRequestedConsoleSession } from "../src/console/runtime/request.ts"
import { consoleInvocationRootPlugin } from "../src/console/vite.ts"

import { runAgent } from "@vite-hub/agent"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "@vite-hub/agent/server"

import type { AgentInvocations, AgentRuntimeContext } from "@vite-hub/agent"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/local-request.ts"

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

  it("orders grouped sessions and runs by their latest activity", () => {
    // SAFETY: The grouping helper only reads the summary fields provided by this focused fixture.
    const invocations = [
      { agentName: "first", id: "newer-created", threadId: "thread", updatedAt: "2026-08-23T10:00:00.000Z" },
      { id: "other", threadId: "other", updatedAt: "2026-08-23T10:30:00.000Z" },
      { agentName: "first", id: "older-created", threadId: "thread", updatedAt: "2026-08-23T11:00:00.000Z" },
      { agentName: "second", id: "separate-agent", threadId: "thread", updatedAt: "2026-08-23T10:45:00.000Z" },
    ] as Parameters<typeof groupConsoleSessions>[0]

    expect(groupConsoleSessions(invocations)).toMatchObject([
      {
        id: "5:first:thread",
        invocations: [{ id: "older-created" }, { id: "newer-created" }],
        updatedAt: "2026-08-23T11:00:00.000Z",
      },
      { id: "6:second:thread", invocations: [{ id: "separate-agent" }] },
      { id: "0::other", invocations: [{ id: "other" }] },
    ])
  })

  it("returns only successful console responses", async () => {
    const request = createConsoleRequest()
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("failed", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ invocations: [] })))

    await expect(request("/first", {})).rejects.toThrow("status 500")
    await expect(request("/second", {})).resolves.toEqual({ invocations: [] })
  })

  it("bounds automatic lookup for a missing routed session", () => {
    const options = {
      cursor: "older",
      isLoadingMore: false,
      requestedSession: "missing",
      sessions: [],
    }

    expect(shouldLoadRequestedConsoleSession({ ...options, loadedPages: 0 })).toBe(true)
    expect(shouldLoadRequestedConsoleSession({
      ...options,
      loadedPages: CONSOLE_SESSION_LOOKUP_PAGE_LIMIT,
    })).toBe(false)
    expect(shouldLoadRequestedConsoleSession({
      ...options,
      loadedPages: 0,
      sessions: [{ id: "missing", invocations: [], updatedAt: "2026-08-23T12:00:00.000Z" }],
    })).toBe(false)
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

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts GET requests from loopback address %s", (address) => {
    expect(() => assertLocalConsoleRequest(event(address))).not.toThrow()
  })

  it("hides console handlers from requests without a trusted socket peer", () => {
    expect(() => assertLocalConsoleRequest(event("203.0.113.2"))).toThrow(expect.objectContaining({ statusCode: 404 }))
    expect(() => assertLocalConsoleRequest(event(undefined))).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("does not trust spoofed localhost forwarding headers from a remote socket", () => {
    const value = event("203.0.113.2")
    value.context = { clientAddress: "127.0.0.1" }
    value.headers = new Headers({ host: "localhost", "x-forwarded-for": "127.0.0.1" })

    expect(() => assertLocalConsoleRequest(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("accepts Nitro forwarding headers after the outer guard", () => {
    const value = event("127.0.0.1")
    value.headers = new Headers({ host: "localhost", "x-forwarded-for": "203.0.113.2" })

    expect(() => assertLocalConsoleRequest(value)).not.toThrow()
  })

  it.each(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"])(
    "rejects the %s proxy header",
    (name) => {
      const value = event("127.0.0.1")
      value.headers = new Headers({ host: "localhost", [name]: "127.0.0.1" })

      expect(() => assertLocalConsolePeer(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
    },
  )

  it("keeps the local host check as defense in depth", () => {
    const value = event("127.0.0.1")
    value.headers = new Headers({ host: "192.0.2.10:3000" })

    expect(() => assertLocalConsoleRequest(value)).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it("rejects non-GET console requests", () => {
    expect(() => assertLocalConsoleRequest(event("127.0.0.1", "POST"))).toThrow(expect.objectContaining({ statusCode: 405 }))
  })
})
