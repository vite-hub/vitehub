import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"

import { assertUniqueOperationNames } from "../src/console/build.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { consoleOperationRegistry as installedRegistry, installConsoleOperations, installConsoleProjectRoot } from "../src/console/runtime/server/operation-contributions.ts"
import { consoleOperationRegistry } from "../src/console/runtime/server/rpc.ts"
import { installedOperationRegistry, operationRootHeader, projectRootHash } from "@vite-hub/internal/operations"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

// A plugin of the app contributes this operation, as `@vite-hub/content` contributes `content.*`.
const greet = defineOperation({
  description: "Greet someone.",
  input: v.strictObject({ name: v.string() }),
  kind: "read",
  name: "fixture.greet",
  run: ({ name }, { surface, user }) => ({ greeting: `Hello ${name}`, surface, user: user?.id ?? null }),
  section: "fixture",
})

const secret = defineOperation({
  description: "Fail with a diagnostic.",
  input: v.strictObject({}),
  kind: "write",
  name: "fixture.fail",
  run: () => {
    throw Object.assign(new Error("Nothing to do."), { code: "FIXTURE_R0001", details: { id: 7 }, fix: "Create one first.", status: 409 })
  },
  section: "fixture",
})

function call(operation: string, input: unknown = {}, headers: Record<string, string> = {}, url = "http://vitehub.local/_vitehub/rpc/__call") {
  return handleConsoleRpcRequest(new Request(url, {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }))
}

afterEach(() => {
  vi.unstubAllEnvs()
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
})

describe("operations that run app code", () => {
  const start = defineOperation({
    description: "Start a job.",
    input: v.strictObject({}),
    invoke: true,
    kind: "write",
    name: "fixture.start",
    run: () => ({ started: true }),
    section: "fixture",
  })

  it("registers them only when console.invoke is on", async () => {
    installConsoleOperations([{ operations: [greet, start], plugin: "fixture-plugin" }], { invoke: false })
    expect(consoleOperationRegistry().list().map(operation => operation.name)).toEqual(expect.arrayContaining(["fixture.greet"]))
    expect(consoleOperationRegistry().get("fixture.start")).toBeUndefined()
    const refused = await call("fixture.start")
    expect(refused.status).toBe(404)

    installConsoleOperations([{ operations: [greet, start], plugin: "fixture-plugin" }], { invoke: true })
    expect(consoleOperationRegistry().get("fixture.start")).toBeDefined()
    await expect((await call("fixture.start")).json()).resolves.toEqual({ ok: true, value: { started: true } })
  })

  async function advertised(): Promise<unknown> {
    const response = await call("sections.list")
    expect(response.status).toBe(200)
    return ((await response.json()) as { value: { operations?: string[] } }).value.operations
  }

  it("tells the pages which of them this access may run, so they hide the rest", async () => {
    installConsoleOperations([{ operations: [greet, start], plugin: "fixture-plugin" }], { invoke: true })
    expect(await advertised()).toEqual(["fixture.start"])

    // Read-only grant: the server would refuse the write, so the page must not offer it.
    installConsoleAccess({ authorize: () => ({ sections: ["fixture:read"] }), mode: "open" })
    expect(await advertised()).toBeUndefined()

    installConsoleAccess({ mode: "open" })
    installConsoleOperations([{ operations: [greet, start], plugin: "fixture-plugin" }], { invoke: false })
    expect(await advertised()).toBeUndefined()
  })

  it("marks the workflow, queue, task, and schedule operations that start app code", async () => {
    const { workflowOperations } = await import("@vite-hub/workflow/operations")
    const { queueOperations } = await import("@vite-hub/queue/operations")
    const { scheduleOperations } = await import("@vite-hub/schedule/operations")
    const { taskOperations } = await import("../src/task/operations.ts")
    const invoking = [...workflowOperations, ...queueOperations, ...scheduleOperations, ...taskOperations].filter(operation => operation.invoke).map(operation => operation.name).sort()
    expect(invoking).toEqual(["queue.send", "schedule.run", "task.run", "workflow.resume", "workflow.start"])
  })
})

describe("contributed operations over the Console RPC", () => {
  it("runs an operation that a plugin contributed", async () => {
    installConsoleOperations([{ operations: [greet, secret], plugin: "fixture-plugin" }])
    const response = await call("fixture.greet", { name: "Ada" })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, value: { greeting: "Hello Ada", surface: "console", user: null } })
    expect(consoleOperationRegistry().list().map(operation => operation.name)).toContain("fixture.greet")
  })

  it("tells an operation that the CLI made the call", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    const response = await call("fixture.greet", { name: "Ada" }, { "x-vitehub-surface": "cli" })
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { surface: "cli" } })
  })

  it("checks the input against the schema and names the fields", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    const response = await call("fixture.greet", { name: 1, extra: true })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: "INTERNAL_R0022", message: expect.stringContaining("Invalid input for fixture.greet"), ok: false, status: 400 })
  })

  it("denies the operation without access to its section", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    installConsoleAccess({ authorize: () => ({ sections: ["kv"] }), mode: "open" })
    const denied = await call("fixture.greet", { name: "Ada" })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ ok: false, status: 403 })
    installConsoleAccess({ authorize: () => ({ sections: ["fixture"] }), mode: "open" })
    expect((await call("fixture.greet", { name: "Ada" })).status).toBe(200)
  })

  it("reports the code, message, fix, and details of a failure", async () => {
    installConsoleOperations([{ operations: [secret], plugin: "fixture-plugin" }])
    const response = await call("fixture.fail")
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ code: "FIXTURE_R0001", details: { id: 7 }, fix: "Create one first.", message: "Nothing to do.", ok: false, status: 409 })
  })

  it("answers 404 for an operation that no plugin contributed", async () => {
    const response = await call("fixture.missing")
    expect(response.status).toBe(404)
  })

  it("fails the build when a plugin reuses the name of another operation", async () => {
    const same = defineOperation({ ...greet, run: ({ name }) => ({ greeting: name, surface: "console" as const, user: null }) })
    const contribution = (plugin: string, operation: unknown) => ({ export: "ops", load: async () => operation, module: "fixture", plugin })
    await expect(assertUniqueOperationNames([contribution("first", greet), contribution("second", same)]))
      .rejects.toMatchObject({ code: "INTERNAL_B0048", message: expect.stringContaining("first and second") })
    const builtin = defineOperation({ ...greet, name: "agents.list" })
    await expect(assertUniqueOperationNames([contribution("shadow", builtin)])).rejects.toMatchObject({ code: "INTERNAL_B0048" })
  })

  it("installs the registry at startup, so agent tools need no prior RPC call", () => {
    const registry = installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    expect(installedOperationRegistry()).toBe(registry)
    expect(registry.get("fixture.greet")).toBeDefined()
    expect(registry.get("agents.list")).toBeDefined()
  })

  it("builds the registry once when nothing is installed", () => {
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.operations"))
    expect(installedRegistry()).toBe(installedRegistry())
  })

  it("serves a development server without sign-in only to this machine", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    vi.stubEnv("NODE_ENV", "development")
    for (const mode of ["local", "open"] as const) {
      installConsoleAccess({ mode })
      expect((await call("fixture.greet", { name: "Ada" }, {}, "http://localhost:5173/_vitehub/rpc/__call")).status).toBe(200)
      expect((await call("fixture.greet", { name: "Ada" }, {}, "http://127.0.0.1:5173/_vitehub/rpc/__call")).status).toBe(200)
      expect((await call("fixture.greet", { name: "Ada" }, {}, "http://[::1]:5173/_vitehub/rpc/__call")).status).toBe(200)
      const lan = await call("fixture.greet", { name: "Ada" }, {}, "http://192.168.1.20:5173/_vitehub/rpc/__call")
      expect(lan.status).toBe(403)
      await expect(lan.json()).resolves.toMatchObject({ code: "CONSOLE_LOOPBACK_ONLY", fix: expect.stringContaining("console.auth"), ok: false })
      const tunnel = await call("fixture.greet", { name: "Ada" }, { "x-forwarded-host": "abc.trycloudflare.com" }, "http://localhost:5173/_vitehub/rpc/__call")
      expect(tunnel.status).toBe(403)
      const rebound = await call("fixture.greet", { name: "Ada" }, { host: "attacker.example" }, "http://localhost:5173/_vitehub/rpc/__call")
      expect(rebound.status).toBe(403)
    }
  })

  it("checks the peer address when the host exposes it, and leaves production alone", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    const handle = (remoteAddress: string) => handleConsoleRpcRequest(new Request("http://localhost:5173/_vitehub/rpc/__call", {
      body: JSON.stringify({ input: { name: "Ada" }, operation: "fixture.greet" }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }), { remoteAddress })
    vi.stubEnv("NODE_ENV", "development")
    expect((await handle("::1")).status).toBe(200)
    expect((await handle("::ffff:127.0.0.1")).status).toBe(200)
    expect((await handle("203.0.113.9")).status).toBe(403)
    // A production server with `console: { auth: false }` is open by choice and serves any host.
    vi.stubEnv("NODE_ENV", "production")
    expect((await call("fixture.greet", { name: "Ada" }, {}, "https://app.example.com/_vitehub/rpc/__call")).status).toBe(200)
  })

  it("does not apply the loopback rule to a signed-in Console", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    vi.stubEnv("NODE_ENV", "development")
    installConsoleAccess({ check: async () => undefined, mode: "auth" })
    expect((await call("fixture.greet", { name: "Ada" }, {}, "http://192.168.1.20:5173/_vitehub/rpc/__call")).status).toBe(200)
  })

  it("names the project of the local dev RPC in a response header", async () => {
    installConsoleOperations([{ operations: [greet], plugin: "fixture-plugin" }])
    installConsoleProjectRoot("/work/app")
    installConsoleAccess({ mode: "local" })
    vi.stubEnv("NODE_ENV", "development")
    const local = await call("fixture.greet", { name: "Ada" }, {}, "http://localhost:5173/_vitehub/rpc/__call")
    expect(local.headers.get(operationRootHeader)).toBe(projectRootHash("/work/app"))
    installConsoleAccess({ mode: "open" })
    expect((await call("fixture.greet", { name: "Ada" })).headers.has(operationRootHeader)).toBe(false)
  })

  it("gives the section resolver the sections that console.authorize allows for a user", async () => {
    const { installedOperationSectionResolver } = await import("@vite-hub/internal/operations")
    const authorize = vi.fn(({ user }: { user?: { id: string } }) => user?.id === "editor" ? { sections: ["content"] } : false)
    installConsoleAccess({ authorize: authorize as never, mode: "open" })
    const resolve = installedOperationSectionResolver()!
    expect(await resolve({ user: { id: "editor" } })).toEqual(["content"])
    expect(await resolve({ user: { id: "viewer" } })).toEqual([])
    expect(await resolve({ user: null })).toEqual([])
    installConsoleAccess({ mode: "open" })
    expect(await installedOperationSectionResolver()!({ user: null })).toBe("all")
  })
})
