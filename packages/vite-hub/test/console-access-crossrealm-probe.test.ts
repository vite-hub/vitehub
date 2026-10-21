import { Window } from "happy-dom"
import { afterEach, describe, expect, it, vi } from "vitest"
import { installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleAuthorize } from "../src/console/auth.ts"

const policyKey = Symbol.for("vitehub.console.access")

afterEach(() => Reflect.deleteProperty(globalThis, policyKey))

// `console.authorize` may return a Response of this runtime. Any other value that is not
// true, false, or { sections } is an invalid result. It never grants access: the route does
// not run and the Console returns the 500 diagnostic that names the valid results.
async function expectInvalidResult(result: unknown): Promise<void> {
  const handler = vi.fn(() => "unreachable")
  installConsoleAccess({ mode: "open", authorize: (() => result) as unknown as ConsoleAuthorize })
  const response = await withConsoleAccess(handler, { anySection: true })({ req: new Request("https://console.example.test/") })
  expect(handler).not.toHaveBeenCalled()
  expect(response).toBeInstanceOf(globalThis.Response)
  expect((response as Response).status).toBe(500)
  await expect((response as Response).json()).resolves.toMatchObject({
    code: "CONSOLE_REQUEST_FAILED",
    message: expect.stringContaining("console.authorize must return true, false, a Response, or { sections: string[] }."),
  })
}

describe("cross-realm console access probe", () => {
  it("passes a foreign request to authorize and does not send its foreign Response", async () => {
    const foreignRealm = new Window()
    const request = new foreignRealm.Request("https://console.example.test/")
    const response = new foreignRealm.Response(null, { status: 401, statusText: "Unauthorized" })
    expect(request).not.toBeInstanceOf(Request)
    expect(response).not.toBeInstanceOf(Response)
    const authorize = vi.fn((() => response) as unknown as ConsoleAuthorize)
    const handler = vi.fn(() => "unreachable")
    installConsoleAccess({ mode: "open", authorize })
    const result = await withConsoleAccess(handler, { anySection: true })({ req: request })
    expect(authorize).toHaveBeenCalledWith({ request })
    expect(handler).not.toHaveBeenCalled()
    expect(result).not.toBe(response)
    expect((result as Response).status).toBe(500)
  })

  it("rejects spoofed response-shaped objects", async () => {
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
    await expectInvalidResult(response)
  })

  it("rejects constructor/prototype response spoofs", async () => {
    const prototype = {
      get body() { return null },
      clone() { return this },
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) },
      blob() { return Promise.resolve(new Blob([])) },
      formData() { return Promise.resolve(new FormData()) },
      json() { return Promise.resolve(null) },
      text() { return Promise.resolve("") },
    }
    // The constructor is named Response, like the global one.
    const FakeResponse = function Response() {}
    Object.assign(FakeResponse, {
      json() { return Object.create(prototype) },
      redirect() { return Object.create(prototype) },
      error() { return Object.create(prototype) },
    })
    Object.defineProperty(prototype, "constructor", { value: FakeResponse })
    Object.setPrototypeOf(FakeResponse, Function)
    FakeResponse.prototype = prototype
    const response = Object.assign(Object.create(prototype), {
      bodyUsed: false, redirected: false, type: "default", url: "", status: 401,
      statusText: "Unauthorized", ok: false, headers: new Headers(),
    })
    await expectInvalidResult(response)
  })

  it("rejects spoofed responses with copied slots", async () => {
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
    await expectInvalidResult(response)
  })

  it("rejects a proxy around a Response and an object created from Response.prototype", async () => {
    await expectInvalidResult(new Proxy(new Response(null, { status: 401 }), {}))
    await expectInvalidResult(Object.create(Response.prototype))
  })

  it("sends a Response of this runtime unchanged", async () => {
    const response = new Response("Sign in at the host.", { status: 401 })
    const handler = vi.fn(() => "unreachable")
    installConsoleAccess({ mode: "open", authorize: () => response })
    await expect(withConsoleAccess(handler, { anySection: true })({ req: new Request("https://console.example.test/") })).resolves.toBe(response)
    expect(handler).not.toHaveBeenCalled()
  })
})
