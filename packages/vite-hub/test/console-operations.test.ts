import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"

import { assertUniqueOperationNames } from "../src/console/build.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { consoleOperationRegistry } from "../src/console/runtime/server/rpc.ts"
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

function call(operation: string, input: unknown = {}, headers: Record<string, string> = {}) {
  return handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
    body: JSON.stringify({ input, operation }),
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1", ...headers },
    method: "POST",
  }))
}

afterEach(() => {
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
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
})
