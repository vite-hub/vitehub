import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"

const policyKey = Symbol.for("vitehub.console.access")

afterEach(() => Reflect.deleteProperty(globalThis, policyKey))

describe("cross-realm console access probe", () => {
  it("preserves foreign requests and responses", async () => {
    const request = runInNewContext(`
      class Headers { get() { return null } }
      class CrossRealmRequest {
        constructor() { this.headers = new Headers(); this.method = "GET"; this.url = "https://console.example.test/" }
      }
      Object.defineProperty(CrossRealmRequest.prototype, Symbol.toStringTag, { value: "Request" })
      new CrossRealmRequest()
    `, { Symbol })
    const response = runInNewContext(`
      class Headers { get() { return null } }
      class CrossRealmResponse {
        constructor() { this.body = null; this.headers = new Headers(); this.status = 401; this.statusText = "Unauthorized" }
      }
      Object.defineProperty(CrossRealmResponse.prototype, Symbol.toStringTag, { value: "Response" })
      new CrossRealmResponse()
    `, { Symbol })
    const authorize = vi.fn(() => response)
    expect(Object.prototype.toString.call(request)).toBe("[object Request]")
    expect(Object.prototype.toString.call(response)).toBe("[object Response]")
    installConsoleAccess({ mode: "host-managed", authorize })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(authorize).toHaveBeenCalledWith({ request })
    expect(authorize.mock.results[0]?.value).toBe(response)
    expect(result).toBe(response)
  })
})
