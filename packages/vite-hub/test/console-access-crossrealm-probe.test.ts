import { Window } from "happy-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleAuthorize } from "../src/console/auth.ts"

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
    installConsoleAccess({ mode: "open", authorize })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(authorize).toHaveBeenCalledWith({ request })
    expect(authorize.mock.results[0]?.value).toBe(response)
    expect(result).toBe(response)
  })

  it("rejects spoofed response-shaped objects", async () => {
    const request = new Request("https://console.example.test/")
    const response = Object.create({
      headers: {
        get() { return null },
        set() {},
        has() { return false },
        append() {},
        delete() {},
        forEach() {},
      },
      status: 401,
      statusText: "Unauthorized",
      get body() { return null },
      clone() { return this },
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) },
      blob() { return Promise.resolve(new Blob([])) },
      formData() { return Promise.resolve(new FormData()) },
      json() { return Promise.resolve(null) },
      text() { return Promise.resolve("") },
    })
    Object.defineProperty(response, Symbol.toStringTag, { value: "Response" })
    installConsoleAccess({ mode: "open", authorize: () => response })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })

  it("rejects constructor/prototype response spoofs", async () => {
    const request = new Request("https://console.example.test/")
    const prototype = {
      get body() { return null },
      clone() { return this },
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) },
      blob() { return Promise.resolve(new Blob([])) },
      formData() { return Promise.resolve(new FormData()) },
      json() { return Promise.resolve(null) },
      text() { return Promise.resolve("") },
    }
    function Response() {}
    Object.assign(Response, {
      json() { return Object.create(prototype) },
      redirect() { return Object.create(prototype) },
      error() { return Object.create(prototype) },
    })
    Object.defineProperty(prototype, "constructor", { value: Response })
    Object.setPrototypeOf(Response, Function)
    Response.prototype = prototype
    const response = Object.assign(Object.create(prototype), {
      bodyUsed: false, redirected: false, type: "default", url: "", status: 401,
      statusText: "Unauthorized", ok: false, headers: new Headers(),
    })
    installConsoleAccess({ mode: "open", authorize: () => response })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })

  it("rejects spoofed responses with copied slots", async () => {
    const request = new Request("https://console.example.test/")
    const prototype = {
      get body() { return null },
      clone() { return this },
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) },
      blob() { return Promise.resolve(new Blob([])) },
      formData() { return Promise.resolve(new FormData()) },
      json() { return Promise.resolve(null) },
      text() { return Promise.resolve("") },
      constructor: class Response {},
    }
    const response = Object.assign(Object.create(prototype), {
      bodyUsed: false,
      redirected: false,
      type: "default",
      url: "",
      status: 401,
      statusText: "Unauthorized",
      ok: false,
      headers: new Headers(),
    })
    installConsoleAccess({ mode: "open", authorize: () => response })
    const result = await withConsoleAccess(() => "unreachable")({ req: request })
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })
})
