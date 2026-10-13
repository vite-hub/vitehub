import { Window } from "happy-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleAuthorize } from "../src/auth.ts"

const policyKey = Symbol.for("vitehub.console.access")

afterEach(() => Reflect.deleteProperty(globalThis, policyKey))

describe("cross-realm console access probe", () => {
  it("preserves foreign requests and responses", async () => {
    const foreignRealm = new Window()
    const request = new foreignRealm.Request("https://console.example.test/")
    const response = new foreignRealm.Response(null, { status: 401, statusText: "Unauthorized" })
    expect(request).not.toBeInstanceOf(Request)
    expect(response).not.toBeInstanceOf(Response)
    const authorize = vi.fn((() => response) as unknown as ConsoleAuthorize)
    installConsoleAccess({ mode: "host-managed", authorize })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(authorize).toHaveBeenCalledWith({ request })
    expect(authorize.mock.results[0]?.value).toBe(response)
    expect(result).toBe(response)
  })

  it("rejects spoofed response-shaped objects", async () => {
    const request = new Request("https://console.example.test/")
    const response = Object.create({
      headers: { get() { return null } },
      status: 401,
      statusText: "Unauthorized",
    })
    Object.defineProperty(response, Symbol.toStringTag, { value: "Response" })
    installConsoleAccess({ mode: "host-managed", authorize: () => response })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })
})
