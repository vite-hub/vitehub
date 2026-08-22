import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { consoleInvocationsKey, consoleInvocationsRegistryKey, consoleInvocationsRootKey, installConsoleInvocationFallback, resolveConsoleInvocations } from "../src/console/internal.ts"
import { createConsoleInvocations, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"
import { assertLocalConsolePeer, assertLocalConsoleRequest } from "../src/console/runtime/server/local-request.ts"
import { consoleInvocationRootPlugin } from "../src/console/vite.ts"

import { runAgent } from "@vite-hub/agent"

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
  vi.restoreAllMocks()
})

describe("Agent invocation console", () => {
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

    const bind = async (projectRoot: string, realm: object) => {
      const plugin = consoleInvocationRootPlugin(projectRoot)
      const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
      const buildStart = plugin.buildStart as unknown as (this: object) => Promise<void>
      const resolveId = plugin.resolveId as unknown as (
        this: object,
        source: string,
        importer: string | undefined,
        options: { isEntry: boolean },
      ) => Promise<{ external?: boolean, id: string } | undefined>
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
      expect(await applyToEnvironment({ config: { consumer: "server" } } as never)).toBe(true)
      expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
      await Reflect.apply(buildStart, context, [])
      const resolved = await Reflect.apply(resolveId, context, ["vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false }])
      const code = await transform("globalThis.agentModuleEvaluated = true", resolvedAgentEntry)
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", undefined, { skipSelf: true })
      expect(context.resolve).toHaveBeenCalledWith("vite-hub/agent", "/app/server/example.agent.ts", { isEntry: false, skipSelf: true })
      expect(resolved).toEqual({ external: false, id: resolvedAgentEntry })
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
    const applyToEnvironment = plugin.applyToEnvironment as NonNullable<typeof plugin.applyToEnvironment>
    const configEnvironment = plugin.configEnvironment as unknown as (
      name: string,
      config: { consumer: "client" | "server" },
    ) => unknown

    expect(await applyToEnvironment({ config: { consumer: "client" } } as never)).toBe(false)
    expect(configEnvironment("client", { consumer: "client" })).toBeUndefined()
    expect(configEnvironment("ssr", { consumer: "server" })).toEqual({ resolve: { noExternal: ["vite-hub"] } })
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
