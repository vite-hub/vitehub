import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"

const policyKey = Symbol.for("vitehub.console.access")

afterEach(() => Reflect.deleteProperty(globalThis, policyKey))

describe("cross-realm console access probe", () => {
  it("preserves foreign requests and responses", async () => {
    const request = runInNewContext(`
      new Request("https://console.example.test/")
    `, { Request })
    const response = runInNewContext(`
      new Response(null, { status: 401, statusText: "Unauthorized" })
    `, { Response })
    const authorize = vi.fn(() => response)
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
